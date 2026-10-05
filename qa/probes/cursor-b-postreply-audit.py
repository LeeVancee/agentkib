#!/usr/bin/env python3
"""Read only the fixed synthetic Cursor B once-only reply; never start a client.

Reports expose synthetic message text, counts and hashes only. Root metadata,
private user context, model system messages and thinking remain opaque.
"""
import argparse
import base64
import collections
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys

sys.dont_write_bytecode = True
HELPER = Path(__file__).with_name('cursor-model-context-audit.py')
EXPECTED_HELPER_SHA = '0d6b2a8eac84890f106ee6ae1d2e38e11a3a7ef326b625d49d37fca364ffbcc9'
helper_bytes = HELPER.read_bytes()
if hashlib.sha256(helper_bytes).hexdigest() != EXPECTED_HELPER_SHA:
    raise RuntimeError('Reviewed helper changed before import')
spec = importlib.util.spec_from_file_location('cursor_readonly_helper', HELPER)
H = importlib.util.module_from_spec(spec)
exec(compile(helper_bytes, str(HELPER), 'exec'), H.__dict__)
E = H.EVIDENCE
NATIVE = '47ee1557-d797-4ba1-a9e7-d03bf4f5ce72'
OPERATION = '687ba192-eba5-4ef5-9aa5-56e06737c6e1'
PROMPT = '基于上面已经导入的历史，只回答两行：第一行是历史中的完整随机标记；第二行是完整项目存储决策及命名空间。不要调用工具、读取工作区文件或执行任何操作。不要猜测或添加解释。'
USER_WIRES = {n: (0 if n in (4, 5, 7, 9, 24, 25, 26) else 2)
              for n in (*range(1, 12), *range(13, 20), *range(21, 28))}
ROOT_WIRES = {n: (0 if n in (10, 17, 26, 33, 37, 39) else 2)
              for n in (1, *range(3, 40))}
ROOT_REPEATED = {1, 3, 4, 8, 9, 12, 13, 14, 15, 16, 18, 20, 21, 23, 24, 29, 30, 31, 34, 35, 38}
AGENT_WIRES = {n: (0 if n == 5 else 2) for n in range(1, 11)}


def shape(rows):
    return [{'number': n, 'wire': w,
             'length': len(v) if isinstance(v, bytes) else len(H.encode_varint(v)),
             'sha256': H.sha(v if isinstance(v, bytes) else H.encode_varint(v))}
            for n, w, v in rows]


def validate_fields(rows, mapping, repeated=()):
    H.require(all(n in mapping and w == mapping[n] for n, w, v in rows),
              'Unknown field or wrong wire in fixed native schema')
    counts = collections.Counter(n for n, w, v in rows)
    H.require(all(n in repeated or count == 1 for n, count in counts.items()),
              'Duplicate singular native field')


def observed_model_history(original, current, expected, get_blob):
    """Only the observed assistant object-key reorder, never general JSON equality."""
    H.require(len(original) == len(expected), 'Original model history count differs')
    matched, transformations, positions = [], [], []
    for old, (role, text) in zip(original, expected):
        generated = json.dumps({'role': role, 'content': [{'type': 'text', 'text': text}]},
                               ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
        H.require(get_blob(old) == generated, 'Original model encoding is not fixed generated UTF-8 JSON')
        allowed = [old]
        vendor_bytes = json.dumps({'role': role, 'content': [{'type': 'text', 'text': text}]},
                                  ensure_ascii=False, separators=(',', ':')).encode()
        if role == 'assistant':
            allowed.append(H.sha(vendor_bytes))
        indices = [index for index, key in enumerate(current) if key in allowed]
        H.require(len(indices) == 1, 'Missing, duplicate or changed original model history')
        index = indices[0]; key = current[index]
        H.require(not positions or index == positions[-1] + 1, 'Original model history order/contiguity changed')
        positions.append(index); matched.append(key)
        if key != old:
            H.require(get_blob(key) == vendor_bytes, 'Assistant rewrite is not exact observed key order')
            transformations.append({'old_sha256': old, 'new_sha256': key,
                                    'change': 'only role/content and type/text JSON object key order'})
    return matched, transformations


def safe_model_usage(composer):
    expected = {'modelName': 'grok-4.7', 'maxMode': False, 'selectedModels': [
        {'modelId': 'grok-4.7', 'parameters': [{'id': 'context', 'value': '256k'},
         {'id': 'reasoning_effort', 'value': 'high'}, {'id': 'fast', 'value': 'true'}]}]}
    H.require(composer['modelConfig'] == expected and
              composer['unifiedMode'] == composer['forceMode'] == 'chat', 'Native model/mode differs')
    H.require(composer.get('usageData') == {}, 'Unreviewed usage object must remain private')
    usage = {key: composer.get(key) for key in ('contextTokensUsed', 'contextTokenLimit', 'contextUsagePercent')}
    H.require(all(value is None or (type(value) in (int, float) and value >= 0)
                  for value in usage.values()), 'Unreviewed context usage value')
    return expected, {'usageData': {}, **usage}


def decode_new_turn(raw, get_blob, prompt):
    turn = H.fields(raw)
    H.require(len(turn) == 1, 'Unknown new UI turn variant')
    agent = H.fields(H.one(turn, 1, 2))
    # Packed uint32 field 6 is a length-delimited payload. No tool dispatch
    # structures (field 8) may occur in this no-tools recall attempt.
    validate_fields(agent, AGENT_WIRES, {2, 6, 8, 9})
    H.require(not any(n == 8 for n, w, v in agent), 'Subagent dispatch observed')
    user = H.fields(get_blob(H.reference(H.one(agent, 1, 2))))
    validate_fields(user, USER_WIRES, {21})
    H.require(H.one(user, 1, 2).decode('utf-8') == prompt, 'New UI user body differs from intent')
    H.one(user, 2, 2).decode('utf-8')
    H.require(not any(n == 5 and v != 0 for n, w, v in user), 'Simulated user is not the authorized prompt')
    H.require(not any(n in (14, 18, 19, 27) for n, w, v in user),
              'Alternate text, execution plan or agent-sent user is unsupported')
    if any(n == 4 for n, w, v in user):
        H.require(H.one(user, 4, 0) == 2, 'New user is not Ask mode')
    replies, thinking, steps = [], 0, []
    for n, w, ref in agent:
        if n != 2:
            continue
        step_id = H.reference(ref)
        step = H.fields(get_blob(step_id))
        H.require(len(step) == 1 and step[0][1] == 2, 'Unknown conversation step structure')
        variant = step[0][0]
        H.require(variant in (1, 3), 'Tool or unknown conversation step observed')
        message = H.fields(step[0][2])
        if variant == 1:
            validate_fields(message, {1: 2, 2: 0, 3: 0})
            replies.append(H.one(message, 1, 2).decode('utf-8'))
        else:
            validate_fields(message, {1: 2, 2: 0, 3: 0, 4: 0})
            H.one(message, 1, 2)  # Never decode or export thinking text.
            thinking += 1
        steps.append({'variant': variant, 'blob_sha256': step_id})
    H.require(len(replies) == 1 and replies[0], 'Expected one complete final assistant message')
    return {'prompt': prompt, 'reply': replies[0], 'thinking_steps': thinking,
            'tool_steps': 0, 'step_variants': steps,
            'agent_metadata': shape([(n, w, v) for n, w, v in agent if n not in (1, 2)]),
            'user_metadata': shape([(n, w, v) for n, w, v in user if n not in (1, 2)])}


def record_bytes(value, total):
    H.require(type(value) in (str, bytes), 'Unexpected SQLite value type')
    raw = value.encode('utf-8') if isinstance(value, str) else value
    H.require(len(raw) <= H.MAX_BLOB, 'Oversized UTF-8 record')
    total += len(raw)
    H.require(total <= H.MAX_TOTAL, 'Read budget exceeded')
    return raw, total


def conversation_root(value):
    H.require(type(value) is str and value.startswith('~'), 'Unknown conversation root encoding')
    return base64.b64decode(value[1:], validate=True)


def save(path, result):
    path = H.canonical(path)
    H.require(path.parent == H.canonical(E / 'live-b') and path.suffix == '.json',
              'Output must stay in dedicated live-b evidence directory')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(result, out, ensure_ascii=False, indent=2)
        out.write('\n'); out.flush(); os.fsync(out.fileno())


def audit(args):
    result = {'passed': False, 'native_id': NATIVE, 'operation_id': OPERATION,
              'audit_script_sha256': H.file_sha(__file__), 'Runtime_starts': 0,
              'native_starts': 0, 'model_requests': 0, 'native_DB_writes': 0,
              'private_prompts_or_thinking_text_saved': False,
              'created_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    protected = {}
    def read(path):
        raw = H.bounded(path)
        protected[str(path)] = H.sha(raw)
        return raw
    try:
        H.require(H.file_sha(HELPER) == EXPECTED_HELPER_SHA, 'Reviewed helper changed')
        state = json.loads(H.bounded(E / 'state.json'))
        case = state['cases']['b']; plan = case['native_plan']
        H.require(case['native_id'] == NATIVE and plan['operation_id'] == OPERATION, 'Wrong fixed B case')
        before = json.loads(read(E / 'model-context-b-independent-before-live.json'))
        H.require(before['passed'] and before['native_id'] == NATIVE and
                  before['proof']['model_message_count'] == 5 and before['proof']['UI_message_count'] == 5,
                  'Missing exact pre-dispatch baseline')
        intent_path = H.canonical(args.intent)
        H.require(intent_path.is_relative_to(H.canonical(E)), 'Intent must be in this evidence case')
        intent = json.loads(read(intent_path))
        H.require(intent['native_id'] == NATIVE and intent['operation_id'] == OPERATION and
                  intent['prompt'] == PROMPT, 'Dispatch identity or full prompt differs')
        expected = H.source_messages(case)
        read(case['source'])
        H.require(H.file_sha(case['source']) == before['source_sha256'], 'Source changed since before dispatch')
        plan_path = Path(case['plan']['change_set']['changes'][0]['target'])
        H.require(json.loads(read(plan_path)) == plan, 'Frozen plan differs from recorded plan')
        payload = json.loads(plan['payload'])
        H.require(H.sha(plan['payload'].encode()) == before['plan_payload_sha256'], 'Reviewed payload changed')
        reviewed_root = base64.b64decode(payload['conversationState'], validate=True)
        original_blobs = {k: base64.b64decode(v, validate=True) for k, v in payload['blobs'].items()}
        H.require(len(original_blobs) == 13, 'Expected exactly thirteen reviewed blobs')
        db_path = H.canonical(plan['cursor']['profile']['db_path'])
        H.require(db_path == H.USERDATA / 'User/globalStorage/state.vscdb', 'Unexpected profile path')
        for suffix in ('-wal', '-shm'):
            if Path(str(db_path) + suffix).exists():
                H.canonical(str(db_path) + suffix)
        with sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True, timeout=0.1) as db:
            db.execute('PRAGMA query_only=ON'); db.execute('BEGIN DEFERRED')
            H.require(db.execute('PRAGMA user_version').fetchone()[0] == 1, 'Unknown database version')
            total, cache = 0, {}
            def record(key):
                nonlocal total
                count, size = db.execute('SELECT count(*),max(length(value)) FROM cursorDiskKV WHERE key=?', (key,)).fetchone()
                H.require(count == 1 and size is not None and size <= H.MAX_BLOB, 'Missing or oversized record')
                value = db.execute('SELECT value FROM cursorDiskKV WHERE key=?', (key,)).fetchone()[0]
                raw, total = record_bytes(value, total)
                return raw
            def blob(key):
                if key not in cache:
                    raw = record('agentKv:blob:' + key)
                    H.require(H.sha(raw) == key, 'Native blob hash mismatch')
                    cache[key] = raw
                return cache[key]
            composer = json.loads(record('composerData:' + NATIVE))
            H.require(composer['composerId'] == NATIVE and composer['_v'] == 18 and
                      composer['status'] == 'completed' and composer['queueItems'] == [] and
                      composer['generatingBubbleIds'] == [], 'Native reply is incomplete or identity changed')
            H.require(composer['workspaceIdentifier']['uri']['fsPath'] == case['workspace'], 'Workspace changed')
            header = db.execute('SELECT workspaceId,isArchived,isSubagent,value FROM composerHeaders WHERE composerId=?', (NATIVE,)).fetchall()
            H.require(len(header) == 1 and header[0][1:3] == (0, 0), 'Native index changed')
            hd = json.loads(header[0][3])
            H.require(hd['composerId'] == NATIVE and hd['workspaceIdentifier']['id'] == header[0][0] and
                      hd['workspaceIdentifier']['uri']['fsPath'] == case['workspace'] and
                      hd['name'] in (payload['name'], '(1) ' + payload['name']), 'Native header changed')
            count = db.execute("SELECT count(*) FROM composerHeaders WHERE json_valid(value) AND json_extract(value,'$.name') IN (?,?)", (payload['name'], '(1) ' + payload['name'])).fetchone()[0]
            H.require(count == 1, 'Duplicate native operation identity')
            root = conversation_root(composer['conversationState'])
            rows = H.fields(root); result['root_fields'] = shape(rows)
            validate_fields(rows, ROOT_WIRES, ROOT_REPEATED)
            H.require(not any(n in (4, 6, 11, 13, 16, 23, 24, 25, 28, 29, 30, 31, 32, 34) for n, w, v in rows),
                      'Pending tools, compaction or subagent/goal history observed')
            H.require(H.one(rows, 9, 2).decode() == Path(case['workspace']).as_uri(), 'Root workspace differs')
            for key, raw in original_blobs.items():
                H.require(H.sha(raw) == key and blob(key) == raw, 'Original model/UI blob changed')
            prompt_refs, turns = H.refs(root, 1), H.refs(root, 8)
            original_prompts, original_turns = H.refs(reviewed_root, 1), H.refs(reviewed_root, 8)
            H.require(turns[:len(original_turns)] == original_turns and len(turns) == len(original_turns) + 1,
                      'Expected one appended UI turn after original exact references')
            matched_prompts, rewrites = observed_model_history(original_prompts, prompt_refs, expected, blob)
            H.require(H.decode_ui(reviewed_root, blob) == expected, 'Original UI role/body differs')
            for ref, (role, text) in zip(original_prompts, expected):
                H.require(json.loads(blob(ref)) == {'role': role, 'content': [{'type': 'text', 'text': text}]},
                          'Original model role/body differs')
            new = decode_new_turn(blob(turns[-1]), blob, PROMPT)
            result['new_turn'] = new
            model_summaries = []
            for ref in prompt_refs:
                if ref in matched_prompts:
                    continue
                # The remaining root prompts can contain system/rules/identity
                # data. Do not fetch, parse, or infer their role/content. New
                # synthetic prompt/reply text is proven by UI UserMessage and
                # AssistantMessage above, never by substring in private JSON.
                count, length = db.execute('SELECT count(*),max(length(value)) FROM cursorDiskKV WHERE key=?',
                                           ('agentKv:blob:' + ref,)).fetchone()
                H.require(count == 1 and length is not None and 0 <= length <= H.MAX_BLOB,
                          'Missing or oversized opaque prompt record')
                model_summaries.append({'reference_sha256': ref, 'bytes': length,
                                        'content_not_read': True, 'content_hash_not_recomputed': True})
            H.require(len(model_summaries) == 3, 'Unexpected count of opaque postreply prompt records')
            model, usage = safe_model_usage(composer)
            result.update(original_model_references=original_prompts, actual_model_references=prompt_refs,
                          original_model_references_raw_unchanged=not rewrites,
                          observed_assistant_JSON_key_order_rewrites=rewrites,
                          original_UI_references=original_turns, actual_UI_references=turns,
                          original_13_blobs_bytes_exact=True, original_full_roles_UTF8_newlines_exact=True,
                          new_model_message_metadata=model_summaries, pending_tool_calls=0,
                          actual_root_sha256=H.sha(root), reviewed_root_sha256=H.sha(reviewed_root),
                          source_sha256=case['source_sha256'], model_config=model,
                          safe_usage=usage, extra_private_prompt_contents_read=False,
                          new_model_JSON_full_text_not_audited=True)
            answer = new['reply']; lines = answer.splitlines()
            decision = 'append-only SQLite WAL with namespace cobalt-lake'
            answer_ok = len(lines) == 2 and lines[0] == case['marker'] and lines[1].rstrip('。.') in (
                decision, 'append-only SQLite WAL, namespace cobalt-lake')
            result['answer_inherits_marker_and_full_decision'] = answer_ok
            H.require(answer_ok, 'Reply does not satisfy complete two-line historical recall')
        for path, digest in protected.items():
            H.require(H.file_sha(path) == digest, 'Protected input changed during audit')
        result.update(passed=True, input_files_sha256=protected,
                      limitations=['No model request was issued by this audit. Operator single-submit evidence does not prove vendor internal request/retry count.',
                                   'No wire capture or billed token assertion; safe usage fields are native observations.',
                                   'All three extra model prompt records remain opaque; their roles/content/tool calls are not audited. New prompt/reply and no-tool claims concern the native UI graph.',
                                   'Known root metadata was wire/count checked and hashed, not interpreted as a whole or ignored. No legacy strict-root prefix success is claimed.',
                                   'Private model context and thinking content were not saved.'])
    except Exception as error:
        result['error'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        result['input_files_sha256'] = protected
    save(args.output, result)
    print(json.dumps({'passed': result['passed'], 'path': str(args.output), 'sha256': H.file_sha(args.output),
                      'error': result.get('error')}, ensure_ascii=False))
    return 0 if result['passed'] else 1


def selftest():
    def f(n, v):
        return H.encode_varint(n * 8 + 2) + H.encode_varint(len(v)) + v
    def integer(n, v):
        return H.encode_varint(n * 8) + H.encode_varint(v)
    blobs = {}
    def add(raw):
        key = H.sha(raw); blobs[key] = raw; return bytes.fromhex(key)
    user = f(1, PROMPT.encode()) + f(2, b'synthetic-id') + integer(4, 2) + f(3, b'PRIVATE')
    reply = f(1, '合成完整答案'.encode()) + integer(2, 1)
    thinking = f(1, b'PRIVATE_THINKING') + integer(2, 8)
    ur, ar, tr = add(user), add(f(1, reply)), add(f(3, thinking))
    good = f(1, f(1, ur) + f(2, tr) + f(2, ar) + integer(5, 13) + f(9, b'declared_not_executed'))
    result = decode_new_turn(good, blobs.__getitem__, PROMPT)
    H.require(result['thinking_steps'] == 1 and result['tool_steps'] == 0 and
              'PRIVATE' not in json.dumps(result), 'Positive safe projection failed')
    bad = [f(1, f(1, ur) + f(2, add(f(2, b'tool')))),
           f(1, f(1, ur) + f(2, add(f(4, b'unknown')))),
           f(2, b'unsupported turn'), good[:-1],
           f(1, f(1, ur) + f(2, ar) + f(2, ar)),
           f(1, f(1, ur) + f(8, b'dispatch') + f(2, ar))]
    for mutation in [f(1, b'wrong'), integer(4, 1), integer(5, 1), f(12, b'unknown'), integer(25, 1) * 2]:
        changed = user + mutation
        bad.append(f(1, f(1, add(changed)) + f(2, ar)))
    for value in bad:
        try:
            decode_new_turn(value, blobs.__getitem__, PROMPT)
        except (RuntimeError, KeyError, UnicodeError):
            continue
        raise RuntimeError('Invalid new UI turn accepted')
    expected = [('user', 'original user\n正文'), ('assistant', 'original answer\n回答')]
    original = [add(json.dumps({'role': role, 'content': [{'type': 'text', 'text': text}]},
                              ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hex()
                for role, text in expected]
    vendor = add(json.dumps({'role': 'assistant', 'content': [{'type': 'text', 'text': expected[1][1]}]},
                           ensure_ascii=False, separators=(',', ':')).encode()).hex()
    matched, changes = observed_model_history(original, [original[0], vendor], expected, blobs.__getitem__)
    H.require(len(changes) == 1 and matched == [original[0], vendor], 'Observed JSON order rewrite rejected')
    history_bad = [[vendor, original[0]], [original[0]], [original[0], vendor, vendor],
                   [original[0], '0' * 64, vendor], [original[0], '0' * 64]]
    for current in history_bad:
        try:
            observed_model_history(original, current, expected, blobs.__getitem__)
        except (RuntimeError, KeyError):
            continue
        raise RuntimeError('Changed model history accepted')
    bad_originals = [original[:-1], original + [original[-1]]]
    for kwargs in [{'ensure_ascii': False, 'indent': 2}, {'ensure_ascii': True, 'separators': (',', ':')}]:
        encoded = json.dumps({'role': 'assistant', 'content': [{'type': 'text', 'text': expected[1][1]}]},
                             sort_keys=True, **kwargs).encode()
        bad_originals.append([original[0], add(encoded).hex()])
    for invalid_original in bad_originals:
        try:
            observed_model_history(invalid_original, [original[0], vendor], expected, blobs.__getitem__)
        except RuntimeError:
            continue
        raise RuntimeError('Unobserved original JSON encoding accepted')
    sample = {'modelConfig': {'modelName': 'grok-4.7', 'maxMode': False, 'selectedModels': [
        {'modelId': 'grok-4.7', 'parameters': [{'id': 'context', 'value': '256k'},
         {'id': 'reasoning_effort', 'value': 'high'}, {'id': 'fast', 'value': 'true'}]}]},
        'unifiedMode': 'chat', 'forceMode': 'chat', 'usageData': {},
        'contextTokensUsed': 7246, 'contextTokenLimit': 256000, 'contextUsagePercent': 2.83046875}
    safe_model_usage(sample)
    for key, value in [('usageData', {'private': 'MUST_NOT_EXPORT'}), ('contextTokensUsed', 'MUST_NOT_EXPORT'),
                       ('contextTokenLimit', True), ('modelConfig', {**sample['modelConfig'], 'unknown': 'MUST_NOT_EXPORT'})]:
        try:
            safe_model_usage({**sample, key: value})
        except RuntimeError:
            continue
        raise RuntimeError('Unsafe model metadata accepted')
    H.require(record_bytes('正文', 0) == ('正文'.encode(), 6), 'UTF-8 budget differs')
    H.require(conversation_root('~YQ==') == b'a', 'Native root encoding rejected')
    boundary_bad = [lambda: record_bytes(1000000000, 0), lambda: record_bytes(None, 0),
                    lambda: record_bytes(True, 0), lambda: record_bytes(1.5, 0),
                    lambda: record_bytes('中' * (H.MAX_BLOB // 3 + 1), 0),
                    lambda: record_bytes('中', H.MAX_TOTAL - 2),
                    lambda: conversation_root('!YQ=='), lambda: conversation_root('YQ=='),
                    lambda: conversation_root(b'~YQ==')]
    for invalid in boundary_bad:
        try:
            invalid()
        except RuntimeError:
            continue
        raise RuntimeError('Unsafe SQLite value or root encoding accepted')
    print(json.dumps({'passed': True, 'positive': 5, 'negative': len(bad) + len(history_bad) + len(bad_originals) + 4 + len(boundary_bad), 'native_or_model_started': False}))
    return 0


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('selftest', 'audit'))
    parser.add_argument('--intent', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.mode == 'audit' and (not args.intent or not args.output):
        parser.error('audit requires --intent and --output')
    sys.exit(selftest() if args.mode == 'selftest' else audit(args))
