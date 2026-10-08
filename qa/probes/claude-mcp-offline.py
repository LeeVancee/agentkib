"""Real Claude CLI + production Backend/Hub; two local mocked model requests only.

python3 qa/probes/claude-mcp-offline.py REPOSITORY NODE22 CLAUDE_BINARY NEW_EVIDENCE_DIR
macOS only. Never forwards HTTP or reads the user's credentials/configuration.
"""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import uuid

TOOL = 'mcp__agentkib__memory_search'
OTHER_TOOLS = ('workspace_get_context', 'asset_list', 'asset_get', 'skill_list',
               'memory_propose', 'session_search', 'session_read_chunk')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)


class OwnedProcesses:
    """Track PID + start identity while ancestors are alive, including setsid children."""
    def __init__(self, child):
        self.child = child
        self.identities = {}
        self.failures = []
        self.stopping = threading.Event()
        self.closed = False
        self.result = None
        rows = self.snapshot()
        root = next((row for row in rows if row['pid'] == child.pid), None)
        if root is None:
            raise RuntimeError('Owned process exited before its identity could be recorded')
        self.identities[child.pid] = root['started']
        self.capture(rows)
        self.watcher = threading.Thread(target=self.watch, daemon=True)
        self.watcher.start()

    @staticmethod
    def snapshot():
        output = subprocess.check_output(['/bin/ps', '-axo', 'pid=,ppid=,stat=,lstart='],
                                         text=True, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'},
                                         timeout=5)
        rows = []
        for line in output.splitlines():
            match = re.fullmatch(r'\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*', line)
            if not match:
                raise RuntimeError('Could not parse owned process snapshot')
            rows.append({'pid': int(match[1]), 'parent': int(match[2]),
                         'status': match[3], 'started': match[4]})
        return rows

    def capture(self, rows=None):
        rows = self.snapshot() if rows is None else rows
        known = {row['pid'] for row in rows
                 if self.identities.get(row['pid']) == row['started']}
        changed = True
        while changed:
            changed = False
            for row in rows:
                if row['parent'] in known and row['pid'] not in known:
                    known.add(row['pid'])
                    self.identities[row['pid']] = row['started']
                    changed = True
        # A zombie has exited; it cannot execute and is waiting for its new parent to reap it.
        return [row for row in rows if row['pid'] in known and not row['status'].startswith('Z')]

    def watch(self):
        while not self.stopping.wait(0.025):
            try:
                self.capture()
            except Exception as error:
                self.failures.append(str(error))
                return

    def stop(self):
        if self.closed:
            if self.result is None:
                raise RuntimeError('Owned process cleanup was not confirmed')
            return self.result
        self.closed = True
        self.stopping.set()
        self.watcher.join(timeout=6)
        if self.watcher.is_alive():
            raise RuntimeError('Owned process observer did not stop')
        for sig in (signal.SIGTERM, signal.SIGKILL):
            rows = self.capture()
            # Stop descendants first, and never signal a PID whose start identity changed.
            for row in reversed(rows):
                current = next((item for item in self.snapshot() if item['pid'] == row['pid']), None)
                if current is None or current['started'] != row['started']:
                    continue
                try:
                    os.kill(row['pid'], sig)
                except ProcessLookupError:
                    pass
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                self.child.poll()
                if not self.capture():
                    break
                time.sleep(0.025)
            if not self.capture():
                self.child.wait(timeout=3)
                if self.failures:
                    raise RuntimeError('Owned process observation failed: ' + '; '.join(self.failures))
                self.result = {'trackedProcessCount': len(self.identities),
                               'allRecordedProcessesExited': True}
                return self.result
        raise RuntimeError('Owned process tree did not exit; retain the evidence directory')


def spawn_owned(*args, **kwargs):
    child = subprocess.Popen(*args, **kwargs, start_new_session=True)
    try:
        child.owned_processes = OwnedProcesses(child)
        return child
    except Exception:
        # Startup observation failure is not success. Best-effort stop the new group;
        # the caller retains evidence because detached descendants cannot be confirmed.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=3)
        raise


def stop_owned(child):
    if child is None:
        return {'trackedProcessCount': 0, 'allRecordedProcessesExited': True}
    tracker = getattr(child, 'owned_processes', None)
    if tracker is None:
        # Supports a still-running synthetic fixture. Production children are registered
        # immediately on spawn, so a detached child remains known after its parent exits.
        tracker = child.owned_processes = OwnedProcesses(child)
    return tracker.stop()


class Backend:
    def __init__(self, node, bundle, project, env, root):
        self.frames = queue.Queue()
        self.sequence = 0
        self.log = (root / 'backend.stderr').open('w')
        self.process = spawn_owned([str(node), str(bundle)], cwd=project, env=env,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=self.log, text=True)
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()
        self.audit = []

    def read(self):
        try:
            for line in self.process.stdout:
                self.frames.put(json.loads(line))
        except Exception as error:
            self.frames.put({'transportError': str(error)})
        finally:
            self.frames.put({'transportError': 'Backend output closed'})

    def rpc(self, method, params=None):
        self.sequence += 1
        identifier = self.sequence
        self.process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': identifier,
                                            'method': method, 'params': params or {}}) + '\n')
        self.process.stdin.flush()
        while True:
            frame = self.frames.get(timeout=20)
            if 'transportError' in frame:
                raise RuntimeError(frame['transportError'])
            if frame.get('id') != identifier:
                continue
            self.audit.append({'method': method, 'response': frame})
            if 'error' in frame:
                raise RuntimeError(json.dumps(frame['error']))
            return frame.get('result')

    def close(self):
        try:
            if self.process.poll() is None:
                self.rpc('agentkib.shutdown')
                self.process.wait(timeout=10)
        finally:
            try:
                self.cleanup = stop_owned(self.process)
            finally:
                self.log.close()


def main():
    if sys.platform != 'darwin' or len(sys.argv) != 5:
        raise RuntimeError('Requires macOS and REPOSITORY NODE22 CLAUDE_BINARY NEW_EVIDENCE_DIR')
    repo, node, claude = (Path(value).resolve(strict=True) for value in sys.argv[1:4])
    root = Path(sys.argv[4]).absolute()
    root.mkdir(mode=0o700, parents=False, exist_ok=False)
    os.umask(0o077)
    root = root.resolve()
    project, home, config, data = (root / name for name in ('project', 'home', 'claude', 'data'))
    for directory in (project / '.agentkib', home, config, data):
        directory.mkdir(parents=True, mode=0o700)
    manifest = project / '.agentkib/manifest.yaml'
    manifest.write_text('schema_version: 2\nworkspace:\n  id: offline-mcp-fixture\n  name: Offline MCP fixture\n')
    marker = 'mcp-marker-' + uuid.uuid4().hex
    memory_text = 'acceptance ' + marker + '; project decision: preserve append-only history.'
    bundle = repo / 'apps/desktop/dist-electron/backend.cjs'
    state = {'schemaVersion': 1, 'scope': 'real-cli-and-hub-mocked-model-boundary',
             'realModelRequests': 0, 'modelRequests': 0, 'toolUseResponses': 0,
             'verifiedToolResults': 0, 'marker': marker, 'backendSha256': digest(bundle),
             'cliSha256': digest(claude), 'failures': [], 'passed': False}
    env = {'PATH': str(node.parent) + ':/usr/bin:/bin', 'HOME': str(home),
           'USERPROFILE': str(home), 'CLAUDE_CONFIG_DIR': str(config),
           'CODEX_HOME': str(home / '.codex'), 'AGENTKIB_HOME': str(home / '.agentkib'),
           'XDG_CONFIG_HOME': str(home / '.config'), 'XDG_DATA_HOME': str(home / '.local/share'),
           'TMPDIR': str(root), 'LANG': 'en_US.UTF-8'}
    save(config / 'settings.json', {'enabledMcpjsonServers': ['agentkib']})
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        hub_port = reservation.getsockname()[1]
    save(data / 'preferences.json', {'mcp_network': {'port': hub_port, 'lan_enabled': False,
                                                   'lan_risk_accepted': False},
                                     'session_index_enabled': False,
                                     'quota_auto_refresh': False})
    backend = None
    child = None
    server = None
    thread = None
    gate = threading.Lock()
    memory_id = None
    tool_id = 'toolu_offline_' + uuid.uuid4().hex

    class Mock(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            try:
                if self.path.split('?')[0] != '/v1/messages':
                    raise RuntimeError('Unexpected local API path: ' + self.path)
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 4 * 1024 * 1024:
                    raise RuntimeError('Invalid local request length')
                body = json.loads(self.rfile.read(length))
                with gate:
                    state['modelRequests'] += 1
                    attempt = state['modelRequests']
                save(root / f'model-request-{attempt}.json', body)
                if attempt > 2:
                    raise RuntimeError('Extra model request refused; no forwarding')
                tools = [tool['name'] for tool in body.get('tools', [])]
                if tools != [TOOL]:
                    raise RuntimeError('Unexpected tool inventory: ' + repr(tools))
                if attempt == 1:
                    if marker in json.dumps(body):
                        raise RuntimeError('Marker leaked into initial prompt or tool metadata')
                    content = [{'type': 'tool_use', 'id': tool_id, 'name': TOOL,
                                'input': {'query': 'acceptance', 'limit': 1}}]
                    reason = 'tool_use'
                    state['toolUseResponses'] += 1
                else:
                    results = [block for message in body.get('messages', [])
                               for block in (message.get('content') if isinstance(message.get('content'), list) else [])
                               if block.get('type') == 'tool_result' and block.get('tool_use_id') == tool_id]
                    if len(results) != 1 or results[0].get('is_error'):
                        raise RuntimeError('Missing or failed native MCP tool result')
                    text = json.dumps(results[0].get('content'))
                    if memory_text not in text or memory_id not in text or 'approved' not in text:
                        raise RuntimeError('Real Hub memory result did not survive native transport')
                    state['verifiedToolResults'] += 1
                    content = [{'type': 'text', 'text': 'OFFLINE_MCP_OK ' + marker}]
                    reason = 'end_turn'
                message = {'id': 'msg_offline_' + str(attempt), 'type': 'message', 'role': 'assistant',
                           'model': body['model'], 'content': content, 'stop_reason': reason,
                           'stop_sequence': None, 'usage': {'input_tokens': 100, 'output_tokens': 20}}
                if body.get('stream'):
                    events = [('message_start', {'type': 'message_start', 'message': {
                        **message, 'content': [], 'stop_reason': None, 'usage': {'input_tokens': 100, 'output_tokens': 0}}})]
                    for index, block in enumerate(content):
                        initial = {**block, 'input': {}} if block['type'] == 'tool_use' else {'type': 'text', 'text': ''}
                        delta = {'type': 'input_json_delta', 'partial_json': json.dumps(block['input'])} if block['type'] == 'tool_use' else {'type': 'text_delta', 'text': block['text']}
                        events.extend([('content_block_start', {'type': 'content_block_start', 'index': index, 'content_block': initial}),
                                       ('content_block_delta', {'type': 'content_block_delta', 'index': index, 'delta': delta}),
                                       ('content_block_stop', {'type': 'content_block_stop', 'index': index})])
                    events.extend([('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': reason, 'stop_sequence': None}, 'usage': {'output_tokens': 20}}),
                                   ('message_stop', {'type': 'message_stop'})])
                    response = ''.join('event: ' + name + '\ndata: ' + json.dumps(value) + '\n\n' for name, value in events).encode()
                    mime = 'text/event-stream'
                else:
                    response = json.dumps(message).encode()
                    mime = 'application/json'
                self.send_response(200)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Length', str(len(response)))
                self.end_headers()
                self.wfile.write(response)
            except Exception as error:
                state['failures'].append(str(error))
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"type":"error","error":{"type":"invalid_request_error","message":"offline guard rejected request"}}')

    try:
        state['cliVersion'] = subprocess.check_output(['/usr/bin/sandbox-exec', '-p', '(version 1)(allow default)(deny network*)', str(claude), '--version'], env=env, text=True, timeout=20).strip()
        if state['cliVersion'] != '2.1.286 (Claude Code)':
            raise RuntimeError('Unexpected native CLI version')
        backend = Backend(node, bundle, project, env, root)
        backend.rpc('backend.initialize', {'dataDir': str(data)})
        plan = backend.rpc('backend.planWorkspace', {'operation': 'add', 'path': str(project), 'context': {'agent_homes': [], 'agentkib_home': str(home / '.agentkib')}})
        scans = backend.rpc('backend.inspectWorkspaces', {'workspaces': [{'id': plan['id'], 'path': plan['path']}]})
        workspace = backend.rpc('workspace.add', {'path': str(project), '_plan': plan, '_inspection': scans[0]['inspection']})
        state['registeredWorkspaceId'] = workspace['id']
        connection = backend.rpc('mcp.planConnection', {'workspaceId': workspace['id'], 'targetAgent': 'claude-code'})
        state['applyReport'] = backend.rpc('changes.apply', {'changeSet': connection, 'approveHome': False})
        mcp = project / '.mcp.json'
        expected_url = f'http://127.0.0.1:{hub_port}/mcp/v1/workspaces/{workspace["id"]}/agents/claude-code'
        if json.loads(mcp.read_text())['mcpServers']['agentkib']['url'] != expected_url:
            raise RuntimeError('Production plan/apply produced an unexpected URL')
        memory = backend.rpc('memories.propose', {'project': str(project), 'proposal': {'project_id': 'offline-mcp-fixture', 'memory_type': 'decision', 'content': memory_text}})
        memory_id = memory['id']
        backend.rpc('memories.review', {'id': memory_id, 'status': 'approved'})
        baseline = backend.rpc('memories.list', {'project': str(project)})
        source_hashes = {str(file.relative_to(root)): digest(file) for file in (manifest, mcp)}
        server = ThreadingHTTPServer(('127.0.0.1', 0), Mock)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        mock_port = server.server_port
        sandbox = f'(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:{mock_port}"))(allow network-outbound (remote ip "localhost:{hub_port}"))'
        (root / 'cli-network.sb').write_text(sandbox + '\n')
        cli_env = {**env, 'ANTHROPIC_API_KEY': 'offline-synthetic-dummy-key',
                   'ANTHROPIC_BASE_URL': f'http://127.0.0.1:{mock_port}',
                   'CLAUDE_CODE_MAX_RETRIES': '0', 'CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES': '0',
                   'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1', 'DISABLE_AUTOUPDATER': '1',
                   'DISABLE_TELEMETRY': '1', 'DISABLE_ERROR_REPORTING': '1', 'ENABLE_TOOL_SEARCH': 'false'}
        arguments = ['/usr/bin/sandbox-exec', '-f', str(root / 'cli-network.sb'), str(claude),
                     '--print', '--output-format', 'stream-json', '--verbose', '--tools', '',
                     '--allowedTools', TOOL, '--disallowedTools', ','.join('mcp__agentkib__' + name for name in OTHER_TOOLS),
                     '--permission-mode', 'dontAsk', '--max-turns', '2', '--max-budget-usd', '0.10',
                     '--model', 'claude-sonnet-4-6', '--disable-slash-commands', '--no-chrome',
                     '--prompt-suggestions', 'false', '--system-prompt', 'Use the allowed read-only MCP tool once, then report its result.',
                     '--strict-mcp-config', '--mcp-config', str(mcp)]
        save(root / 'cli-arguments.json', arguments)
        with (root / 'cli.stdout').open('w') as output, (root / 'cli.stderr').open('w') as errors:
            child = spawn_owned(arguments, env=cli_env, cwd=project, stdin=subprocess.PIPE,
                                     stdout=output, stderr=errors, text=True)
            child.communicate('Read the approved project memory matching acceptance, then repeat its marker and project decision.\n', timeout=90)
        state['cliExitCode'] = child.returncode
        frames = [json.loads(line) for line in (root / 'cli.stdout').read_text().splitlines() if line.strip()]
        uses = [block for frame in frames if frame.get('type') == 'assistant'
                for block in frame.get('message', {}).get('content', []) if block.get('type') == 'tool_use']
        state['nativeToolCalls'] = len(uses)
        results = [frame for frame in frames if frame.get('type') == 'result']
        state['sourceUnchanged'] = baseline == backend.rpc('memories.list', {'project': str(project)}) and all(digest(root / name) == value for name, value in source_hashes.items())
        state['sourceSha256'] = source_hashes
        if child.returncode != 0 or state['failures'] or state['modelRequests'] != 2 or state['verifiedToolResults'] != 1 or len(uses) != 1 or uses[0]['name'] != TOOL or not state['sourceUnchanged'] or len(results) != 1 or results[0].get('is_error') or marker not in results[0].get('result', ''):
            raise RuntimeError('Native MCP offline acceptance assertion failed')
        state['passed'] = True
    except Exception as error:
        state['failures'].append(str(error))
    finally:
        # Every owned resource gets a cleanup attempt even if an earlier one fails.
        try:
            state['cliProcessCleanup'] = stop_owned(child)
        except Exception as error:
            state['failures'].append('CLI cleanup: ' + str(error))
        state['ownedCliExited'] = child is None or child.poll() is not None
        if server is not None:
            try:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)
                if thread.is_alive():
                    raise RuntimeError('Local mock server did not stop')
            except Exception as error:
                state['failures'].append('Mock cleanup: ' + str(error))
        if backend is not None:
            try:
                backend.close()
            except Exception as error:
                state['failures'].append('Backend cleanup: ' + str(error))
            state['ownedBackendExited'] = backend.process.poll() is not None
            state['backendProcessCleanup'] = getattr(backend, 'cleanup', None)
            save(root / 'backend-rpc.json', backend.audit)
        if state['failures']:
            state['passed'] = False
        save(root / 'result.json', state)
    print(json.dumps({'passed': state['passed'], 'evidence': str(root), 'modelRequests': state['modelRequests'],
                      'realModelRequests': 0, 'failures': state['failures']}, indent=2))
    return 0 if state['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
