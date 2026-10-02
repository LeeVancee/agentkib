"""Fixed OpenClaw 2026.9.6 embedded TUI restore; no input or model request.

Usage: python3 openclaw-offline-tui.py EXISTING_CASE NEW_EVIDENCE_DIR
Original databases remain the only runtime targets. SQLite backups are evidence.
"""
import argparse
import codecs
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('native_offline_tui', HERE / 'native-offline-tui.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def snapshot(path, destination):
    with sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True) as source:
        with sqlite3.connect(destination) as backup:
            source.backup(backup)
    tables = {}
    with sqlite3.connect(destination) as db:
        for name, schema in db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name"):
            quoted = '"' + name.replace('"', '""') + '"'
            rows = sorted(json.dumps(list(row), default=lambda value: {'bytesHex': value.hex()},
                                     ensure_ascii=False, separators=(',', ':'))
                          for row in db.execute('SELECT * FROM ' + quoted))
            tables[name] = {'rows': len(rows), 'sha256': hashlib.sha256('\n'.join(rows).encode()).hexdigest(),
                            'schemaSha256': hashlib.sha256((schema or '').encode()).hexdigest()}
    return tables


def validate_ui(raw, expected):
    """Pinned dark xterm-256color renderer: users have background 59, assistants none.

    This is not an assertion that the TUI prints literal role labels. Roles are
    corroborated by the official projection and the fixed User/AssistantMessage
    component dispatch at tui-CkjtweOT.mjs:6372-6395. Only ANSI layout and terminal
    wrap/padding whitespace are normalized; all message characters remain exact.
    """
    control = re.compile(r'\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]')
    chars, roles, background = [], [], None

    def text(chunk):
        for char in chunk:
            if char.isspace():
                if chars and chars[-1] != ' ':
                    chars.append(' '); roles.append(None)
            else:
                chars.append(char)
                roles.append('user' if background == 59 else 'assistant' if background is None else 'other')

    last = 0
    for match in control.finditer(raw):
        text(raw[last:match.start()])
        sequence = match.group()
        if sequence.startswith('\x1b[') and sequence.endswith('m'):
            codes = [int(value or 0) for value in sequence[2:-1].split(';')]
            index = 0
            while index < len(codes):
                code = codes[index]
                if code in (0, 49): background = None
                elif code in (38, 48) and index + 2 < len(codes):
                    if codes[index + 1] == 5:
                        if code == 48: background = codes[index + 2]
                        index += 2
                    elif codes[index + 1] == 2:
                        if code == 48: background = tuple(codes[index + 2:index + 5])
                        index += 4
                index += 1
        last = match.end()
    text(raw[last:])
    visible = ''.join(chars)
    offset, checked = 0, []
    assert [turn['role'] for turn in expected] == ['user', 'user', 'assistant']
    for turn in expected:
        body = '\n'.join(block['text'] for block in turn['blocks'])
        assert all(block['type'] == 'text' for block in turn['blocks'])
        normalized = ' '.join(body.split())
        position = visible.find(normalized, offset)
        assert position >= 0, f'Complete {turn["role"]} body missing from native UI'
        assert all(roles[position + i] == turn['role'] for i, char in enumerate(normalized) if not char.isspace()), 'Pinned native role rendering mismatch'
        offset = position + len(normalized)
        checked.append({'role': turn['role'], 'fullBodyMatched': True, 'position': position})
    return {'turns': checked, 'literalRoleLabels': False,
            'roleEvidence': 'Exact official role projection plus fixed UserMessage/AssistantMessage component rendering',
            'normalization': 'ANSI controls and terminal wrap/padding whitespace only'}


def validate_ui_capture(raw, expected, *, chunk_size=4096):
    """Decode strictly across reads, allowing only a cut final pinned UI border.

    The owned PTY stops after the final body is visible, so a read can end inside
    the following border glyph. Never discard invalid bytes, missing body text,
    or an arbitrary incomplete suffix. Keep the original capture and account for
    any pending bytes explicitly after validating every expected message.
    """
    assert chunk_size > 0
    decoder = codecs.getincrementaldecoder('utf-8')(errors='strict')
    text = ''.join(decoder.decode(raw[offset:offset + chunk_size], final=False)
                   for offset in range(0, len(raw), chunk_size))
    pending, _ = decoder.getstate()
    projection = validate_ui(text, expected)
    if pending:
        border = re.search(r'(?:\r?\n)\x1b\[38;5;59m─+\Z', text)
        assert border is not None and pending in (b'\xe2', b'\xe2\x94'), 'Incomplete UTF-8 outside pinned trailing UI border'
        last_body = '\n'.join(block['text'] for block in expected[-1]['blocks'])
        body_at = text.rfind(last_body)
        assert body_at >= 0 and body_at + len(last_body) <= border.start(), 'Truncated decoration does not follow complete final body'
    else:
        decoder.decode(b'', final=True)
    projection['captureDecoding'] = {
        'mode': 'strict incremental UTF-8', 'rawSha256': hashlib.sha256(raw).hexdigest(),
        'rawBytes': len(raw), 'rawBytesPreserved': True,
        'pendingTailHex': pending.hex(), 'pendingTailOffset': len(raw) - len(pending),
        'tailClassification': 'incomplete pinned UI border after all complete turns' if pending else 'complete UTF-8',
    }
    return projection


def validate_metadata(evidence, session_key, scope, started_ms, finished_ms):
    key = 'tui.lastSession.' + hashlib.sha256(f'{scope}\nmain\nlocal embedded'.encode()).hexdigest()[:32]
    def rows(stage):
        with sqlite3.connect(evidence / (stage + '-state.sqlite')) as db:
            return {row[0]: row for row in db.execute('SELECT state_key,value_json,updated_at_ms FROM config_machine_state')}
    before, after = rows('before'), rows('after')
    assert {k: v for k, v in before.items() if k != key} == {k: v for k, v in after.items() if k != key}, 'Unrelated machine-state rows changed'
    assert key in after and json.loads(after[key][1]) == session_key, 'Unexpected TUI restore pointer'
    assert started_ms <= after[key][2] <= finished_ms, 'TUI metadata timestamp outside run'
    return {'table': 'config_machine_state', 'state_key': key, 'before': before.get(key), 'after': after[key],
            'allowedColumns': ['value_json', 'updated_at_ms']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('case', type=Path)
    parser.add_argument('evidence_dir', type=Path)
    parser.add_argument('--list-evidence', type=Path, help='Previously verified official sessions-list raw output')
    args = parser.parse_args()
    case, evidence = args.case.resolve(), args.evidence_dir.resolve()
    os.umask(0o077)
    evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    source = Path(__file__).read_bytes()
    (evidence / 'runner.py').write_bytes(source)
    (evidence / 'native-offline-tui.py').write_bytes((HERE / 'native-offline-tui.py').read_bytes())
    prior = json.loads((case / 'result.json').read_text())
    plan = json.loads(next((case / 'data/continuations').rglob('plan.json')).read_text())
    assert prior['target'] == 'openclaw' and plan['version'] == '2026.9.6'
    env = runner.isolated_environment(case)
    native = [plan['openclaw']['node'], plan['executable']]
    sid = prior['operations'][0]['target_session_id']
    agent_db = Path(plan['openclaw']['agent_dir']) / 'openclaw-agent.sqlite'
    state_db = Path(plan['openclaw']['state_database'])
    assert agent_db.is_relative_to(case) and state_db.is_relative_to(case)
    summary = {'case': str(case), 'sessionId': sid, 'runnerSha256': hashlib.sha256(source).hexdigest(),
               'nativeRunnerSha256': hashlib.sha256((HERE / 'native-offline-tui.py').read_bytes()).hexdigest(),
               'runs': [], 'passed': False, 'noInputSent': True, 'noModelPromptSent': True,
               'allNativeChildrenNetworkDenied': True, 'backupsUsedAsRuntimeTarget': False}
    summary['binaries'] = {label: {'path': str(path), 'sha256': hashlib.sha256(Path(path).read_bytes()).hexdigest()}
                           for label, path in [('node', native[0]), ('entry', native[1])]}
    config_path = Path(plan['openclaw']['config_path'])
    summary['configSha256Before'] = hashlib.sha256(config_path.read_bytes()).hexdigest()
    runner.save(evidence / 'environment.json', env)

    def command(name, args, **kwargs):
        record = runner.run_owned(runner.SANDBOX + args, env, plan['workspace'],
                                  evidence / (name + '.ansi'), timeout=45, **kwargs)
        assert record['ownedProcessGroupGone'], 'Owned process group remains'
        return record

    def verify(stage):
        directory = evidence / stage
        directory.mkdir(mode=0o700)
        code = ('import sys; sys.path.insert(0,sys.argv[1]); from interop_native_readback import verify; '
                'verify(sys.argv[2],evidence_dir=sys.argv[3])')
        record = command(stage, [sys.executable, '-c', code, str(HERE), str(case), str(directory)])
        assert record['exitCodeAfterCleanup'] == 0, 'Independent readback failed'
        return json.loads((directory / 'independent-verification.json').read_text())

    def snapshot_both(stage):
        return {name: snapshot(path, evidence / (stage + '-' + name + '.sqlite'))
                for name, path in [('agent', agent_db), ('state', state_db)]}

    before_done = False
    try:
        summary['before'] = verify('before')
        summary['beforeTables'] = snapshot_both('before')
        before_done = True
        version = command('version', native + ['--version'])
        assert version['exitCodeAfterCleanup'] == 0
        version_text = (evidence / 'version.ansi').read_text().strip()
        assert re.fullmatch(r'OpenClaw 2026\.9\.6 \(eb377ac\)', version_text), 'Pinned CLI version drift'
        summary['reportedVersion'] = '2026.9.6'
        previous_list = args.list_evidence.resolve() if args.list_evidence else evidence.parent / (case.name + '-list') / 'list-2.ansi'
        summary['officialListEvidence'] = {'path': str(previous_list), 'sha256': hashlib.sha256(previous_list.read_bytes()).hexdigest()}
        sessions = json.loads(previous_list.read_text())
        target, = [entry for entry in sessions['sessions'] if entry['sessionId'] == sid]
        summary['sessionKey'] = target['key']
        summary['startedMs'] = int(time.time() * 1000)
        last_body = plan['expected']['turns'][-1]['blocks'][0]['text']
        assert '\n' not in last_body and len(last_body) < 180, 'Unsupported final-message layout'
        for run in range(2):
            record = command(f'tui-{run + 1}', native + ['tui', '--local', '--session', target['key'],
                             '--history-limit', '1000'],
                             needles=(last_body.encode(),))
            summary['runs'].append(record)
            assert all(record['needleMatches']), f'History not visible: {record["stopReason"]}'
            record['fullUiProjection'] = validate_ui_capture((evidence / f'tui-{run + 1}.ansi').read_bytes(), plan['expected']['turns'])
        summary['passed'] = True
    except BaseException as exc:
        summary['error'] = f'{type(exc).__name__}: {exc}'
    finally:
        if before_done:
            try:
                summary['after'] = verify('after')
                summary['afterTables'] = snapshot_both('after')
                summary['changedTables'] = {database: [table for table in sorted(set(before) | set(summary['afterTables'][database]))
                                                      if before.get(table) != summary['afterTables'][database].get(table)]
                                           for database, before in summary['beforeTables'].items()}
                assert not summary['changedTables']['agent'], 'Unexpected agent database table mutation'
                assert set(summary['changedTables']['state']) <= {'config_machine_state'}, 'Unexpected global state table mutation'
                assert summary['beforeTables']['state']['config_machine_state']['schemaSha256'] == summary['afterTables']['state']['config_machine_state']['schemaSha256'], 'Machine-state schema changed'
                summary['configSha256After'] = hashlib.sha256(config_path.read_bytes()).hexdigest()
                assert summary['configSha256Before'] == summary['configSha256After'], 'Isolated config changed'
                config = json.loads(config_path.read_text())
                if summary.get('runs'):
                    summary['metadataChange'] = validate_metadata(evidence, summary['sessionKey'],
                        config.get('session', {}).get('scope', 'per-sender'), summary['startedMs'], int(time.time() * 1000))
                # Native housekeeping may update derived metadata, never transcript
                # events or existing session entries during a history-only restore.
                for table in ['session_nodes', 'transcript_events', 'transcript_event_identities']:
                    assert summary['beforeTables']['agent'][table] == summary['afterTables']['agent'][table], table + ' changed'
            except BaseException as exc:
                summary['passed'] = False
                summary['afterError'] = f'{type(exc).__name__}: {exc}'
        runner.save(evidence / 'result.json', summary)
    print(json.dumps({key: summary.get(key) for key in ['case', 'passed', 'error', 'afterError', 'changedTables']}))
    return 0 if summary['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
