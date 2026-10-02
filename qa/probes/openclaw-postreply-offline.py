"""Read-only-model addendum: restore the five already-saved OpenClaw turns offline.

LIVE_ATTEMPT NEW_EVIDENCE; original target, no clone/import/input/model request.
The original model-answer verdict is preserved independently of TUI restoration.
"""
import argparse
import codecs
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import sys
import time
from openclaw_metadata_contract import validate_metadata, stat_record

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('old_openclaw_offline', HERE / 'openclaw-offline-tui.py')
old = importlib.util.module_from_spec(spec); spec.loader.exec_module(old)
runner = old.runner
CANCELLED = []
READ_SCRIPT = """
import {pathToFileURL} from 'node:url';
const p=JSON.parse(process.argv[1]);
const load=n=>import(pathToFileURL(p.package+'/dist/'+n));
const {n:readOnly}=await load('openclaw-agent-db-readonly-IBx2zWDG.mjs');
const {l:events}=await load('session-accessor.sqlite-read-DG0i0-yW.mjs');
const out=readOnly(d=>({events:events(d,p.sid),count:d.db.prepare('SELECT COUNT(*) AS n FROM session_nodes').get().n,
matches:d.db.prepare('SELECT COUNT(*) AS n FROM session_nodes WHERE current_session_id=?').get(p.sid).n}),
{agentId:'main',env:process.env,path:p.database});
if(!out.found)throw Error('Missing native database');console.log(JSON.stringify(out.value));
"""


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def validate_target(prior, plan):
    assert prior['target'] == 'openclaw' and plan['target_agent'] == 'open-claw'
    assert plan['version'] == '2026.9.6'


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
    assert [turn['role'] for turn in expected] == ['user', 'user', 'assistant', 'user', 'assistant']
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
        validate_ui(text[:border.start()], expected)
    else:
        decoder.decode(b'', final=True)
    projection['captureDecoding'] = {
        'mode': 'strict incremental UTF-8', 'rawSha256': hashlib.sha256(raw).hexdigest(),
        'rawBytes': len(raw), 'rawBytesPreserved': True,
        'pendingTailHex': pending.hex(), 'pendingTailOffset': len(raw) - len(pending),
        'tailClassification': 'incomplete pinned UI border after all complete turns' if pending else 'complete UTF-8',
    }
    return projection


def expected_turns(events):
    turns = []
    for event in events:
        if event['type'] != 'message': continue
        message = event['message']
        blocks = message['content']
        if isinstance(blocks, str): blocks = [{'type': 'text', 'text': blocks}]
        assert isinstance(blocks, list) and blocks
        for b in blocks:
            assert isinstance(b, dict) and b['type'] in ('text','thinking')
            assert isinstance(b.get('text') if b['type']=='text' else b.get('thinking'),str)
        blocks=[b for b in blocks if b['type']=='text']
        assert blocks, 'No visible message text'
        turns.append({'role': message['role'], 'blocks': blocks})
    assert [turn['role'] for turn in turns] == ['user', 'user', 'assistant', 'user', 'assistant']
    return turns


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('live_attempt', type=Path)
    parser.add_argument('evidence', type=Path)
    args = parser.parse_args()
    live, evidence = args.live_attempt.resolve(), args.evidence.resolve()
    os.umask(0o077); evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    attempt = json.loads((live / 'attempt.json').read_text())
    outcome = json.loads((live / 'result.json').read_text())
    assert attempt['mock'] == outcome['mock']
    assert outcome['relay']['dispatchAttempts'] == 1 and outcome['relay']['responses'] == [200]
    case = Path(attempt['publicCase']).resolve()
    prior = json.loads((case / 'result.json').read_text())
    plan_file, = (case / 'data/continuations').rglob('plan.json')
    plan = json.loads(plan_file.read_text()); sid = outcome['sessionId']
    validate_target(prior, plan)
    assert sid == prior['operations'][0]['target_session_id']
    assert sha(plan_file) == prior['operations'][0]['launch_request']['plan_hash']
    frozen = json.loads((live / 'native-after.json').read_text())
    assert frozen['count'] == 6 and frozen['matches'] == 1
    turns = expected_turns(frozen['events'])
    assert frozen['events'][:len(json.loads(plan['payload']))] == json.loads(plan['payload'])
    native = ['/opt/homebrew/Cellar/node/26.9.0/bin/node', plan['executable']]
    assert sha(native[0]) == '91ed66b8cd139609427a3e9d93518dd3b0d5407c737fc9a265bfd991ec623d8a'
    env=json.loads((case/'environment.json').read_text())
    assert not set(env)-(runner.PATH_KEYS|runner.FLAG_KEYS|{'PATH','LANG','DISABLE_AUTOUPDATER','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'})
    env={k:v for k,v in env.items() if k not in ('DISABLE_AUTOUPDATER','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')}
    for k in runner.PATH_KEYS & set(env):assert Path(env[k]).resolve().is_relative_to(case)
    env.update(TERM='xterm-256color')
    agent_db = Path(plan['openclaw']['agent_dir']) / 'openclaw-agent.sqlite'
    state_db = Path(plan['openclaw']['state_database'])
    config_path = Path(plan['openclaw']['config_path'])
    if attempt['mock']:
        state=live/'openclaw';env['OPENCLAW_STATE_DIR']=str(state);env['OPENCLAW_CONFIG_PATH']=str(state/'openclaw.json')
        agent_db=state/'agents/main/agent/openclaw-agent.sqlite';state_db=state/'state/openclaw.sqlite';config_path=state/'openclaw.json'
    assert all(path.resolve().is_relative_to(live if attempt['mock'] else case) for path in (agent_db,state_db,config_path))
    original_config = config_path.read_bytes()
    session_key = 'agent:main:agentkib:' + sid
    summary = {'passed': False, 'case': str(case), 'sessionId': sid, 'sessionKey': session_key,
        'liveAttempt': str(live), 'originalModelAnswerPassed': outcome['passed'],
        'originalReplyProvesImportedContext': outcome['replyProvesImportedContext'],
        'originalResultSha256': sha(live / 'result.json'), 'restorationOnly': True,
        'inputBytesSent': 0, 'modelRequests': 0, 'allNativeChildrenNetworkDenied': True,
        'backupsUsedAsRuntimeTarget': False, 'commands': []}
    for filename in ('openclaw-postreply-offline.py', 'openclaw-offline-tui.py', 'native-offline-tui.py', 'openclaw_metadata_contract.py'):
        (evidence / filename).write_bytes((HERE / filename).read_bytes())
    summary['implementationSha256'] = {filename: sha(HERE / filename) for filename in
        ('openclaw-postreply-offline.py', 'openclaw-offline-tui.py', 'native-offline-tui.py', 'openclaw_metadata_contract.py')}
    renderer = Path(plan['openclaw']['package']) / 'dist/tui-CkjtweOT.mjs'
    summary['binaries'] = {label: {'path': str(path), 'sha256': sha(path)} for label, path in
                          [('node', native[0]), ('entry', native[1]), ('renderer', renderer)]}
    runner.save(evidence / 'environment.json', env)
    runner.save(evidence / 'expected-turns.json', turns)

    def command(name, argv, timeout=30):
        result = runner.run_owned(runner.SANDBOX + argv, env, plan['workspace'], evidence / (name + '.ansi'), timeout=timeout)
        result.update(supervisorPid=os.getpid(),cwd=plan['workspace'],nativeArgv=argv)
        summary['commands'].append(result)
        assert result['ownedProcessGroupGone'] and not result['inputSent'] and result['cancellationSignal'] is None
        return result

    def read(stage):
        spec = {'package': plan['openclaw']['package'], 'sid': sid, 'database': str(agent_db)}
        record = command(stage, [native[0], '--input-type=module', '-e', READ_SCRIPT, json.dumps(spec)])
        assert record['exitCodeAfterCleanup'] == 0
        value = json.loads((evidence / (stage + '.ansi')).read_text())
        runner.save(evidence / (stage + '.json'), value)
        assert value == frozen, 'Official accessor events, unique ID or count changed'
        return value

    def check_source(stage):
        code = ('import sys,json,hashlib;from pathlib import Path;sys.path.insert(0,sys.argv[1]);'
            'from interop_native_readback import verify_native_source,validate_receipts;'
            'case=Path(sys.argv[2]);p=json.loads((case/"result.json").read_text());validate_receipts(p);'
            'assert hashlib.sha256(Path(p["source"]).read_bytes()).hexdigest()==p["sourceSha256"];'
            'assert all(hashlib.sha256(Path(i["path"]).read_bytes()).hexdigest()==i["sha256"] for i in p.get("sourceMetadata",[]));'
            'verify_native_source(p,json.loads((case/"environment.json").read_text()));print("source unchanged")')
        record = command(stage, [sys.executable, '-c', code, str(HERE), str(case)])
        assert record['exitCodeAfterCleanup'] == 0

    def snapshots(stage):
        stat_script="import fs from 'node:fs';const s=fs.statSync(process.argv[1],{bigint:true});console.log(JSON.stringify({dev:String(s.dev),ino:String(s.ino),birthtimeNs:String(s.birthtimeNs),size:Number(s.size)}))"
        stat_name='agent-physical-'+stage
        stat_record_result=command(stat_name,[native[0],'--input-type=module','-e',stat_script,str(agent_db)])
        assert stat_record_result['exitCodeAfterCleanup']==0
        runner.save(evidence/(stat_name+'.json'),json.loads((evidence/(stat_name+'.ansi')).read_text()))
        return {label: old.snapshot(path, evidence / (stage + '-' + label + '.sqlite'))
                for label, path in [('agent', agent_db), ('state', state_db)]}

    before_done = False
    try:
        check_source('source-before'); summary['before'] = read('native-before')
        summary['beforeTables'] = snapshots('before'); before_done = True
        version = command('version', native + ['--version'])
        assert version['exitCodeAfterCleanup'] == 0
        assert re.fullmatch(r'OpenClaw 2026\.9\.6 \(eb377ac\)', (evidence / 'version.ansi').read_text().strip())
        summary['reportedVersion'] = '2026.9.6'
        if CANCELLED: raise InterruptedError('Cancelled before TUI')
        runner.save(evidence/'config-stat-before.json',stat_record(config_path))
        summary['startedMs'] = int(time.time() * 1000)
        # A substring of the last answer occurs in imported history. Do not stop
        # early on that substring: passively collect a bounded full render.
        summary['fullUiProjections']=[]
        for index in (1,2):
            if CANCELLED:raise InterruptedError('Cancelled between restores')
            name='tui-'+str(index)
            record=command(name,native+['tui','--local','--session',session_key,'--history-limit','1000'],timeout=12)
            assert record['stopReason']=='timeout', 'TUI exited or exceeded capture bound'
            summary['fullUiProjections'].append(validate_ui_capture((evidence/(name+'.ansi')).read_bytes(),turns))
            read('native-after-'+str(index))
        summary['passed'] = True
    except BaseException as exc:
        summary['error'] = type(exc).__name__ + ': ' + str(exc)
    finally:
        if before_done:
            try:
                summary['after'] = read('native-after'); check_source('source-after')
                summary['afterTables'] = snapshots('after')
                summary['changedTables'] = {database: [table for table in sorted(set(before) | set(summary['afterTables'][database]))
                    if before.get(table) != summary['afterTables'][database].get(table)] for database, before in summary['beforeTables'].items()}
                assert config_path.read_bytes() == original_config
                summary['sourceUnchanged'] = summary['configBytesUnchanged'] = True
                if 'startedMs' in summary:
                    summary['metadataChange'] = validate_metadata(evidence, session_key,
                        json.loads(original_config).get('session', {}).get('scope', 'per-sender'), summary['startedMs'], int(time.time() * 1000),config_path,original_config,summary['commands'])
                assert sha(live / 'result.json') == summary['originalResultSha256']
                summary['originalVerdictPreserved'] = True
            except BaseException as exc:
                summary['passed'] = False; summary['afterError'] = type(exc).__name__ + ': ' + str(exc)
        summary['cancellationSignals'] = list(CANCELLED)
        if CANCELLED: summary['passed'] = False
        runner.save(evidence / 'result.json', summary)
    print(json.dumps({k: summary.get(k) for k in ('passed', 'error', 'afterError', 'originalModelAnswerPassed', 'changedTables')}))
    return 0 if summary['passed'] else 1


if __name__ == '__main__':
    previous = {sig: signal.signal(sig, lambda value, _frame: CANCELLED.append(value))
                for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
    try: sys.exit(main())
    finally:
        for sig, handler in previous.items(): signal.signal(sig, handler)
