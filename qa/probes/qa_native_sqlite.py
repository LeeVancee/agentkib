"""Exact SQLite evidence encoding. Raw row equality remains the acceptance check."""
import base64
import json
import sqlite3
from pathlib import Path


def read_hermes_state(home, session_id):
    with sqlite3.connect('file:' + str(Path(home) / 'state.db') + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        rows = [dict(row) for row in db.execute('SELECT * FROM messages WHERE session_id=? ORDER BY id', (session_id,))]
        total = db.execute('SELECT count(*) FROM sessions').fetchone()[0]
    return rows, total


def encode(value):
    if isinstance(value, bytes):
        return {'$sqliteBlobBase64': base64.b64encode(value).decode('ascii')}
    if isinstance(value, dict):
        assert '$sqliteBlobBase64' not in value, 'Reserved snapshot marker collision'
        return {key: encode(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [encode(item) for item in value]
    return value


def decode(value):
    if isinstance(value, dict):
        if '$sqliteBlobBase64' in value:
            assert len(value) == 1
            return base64.b64decode(value['$sqliteBlobBase64'], validate=True)
        return {key: decode(item) for key, item in value.items()}
    if isinstance(value, list):
        return [decode(item) for item in value]
    return value


def write_snapshot(path, rows):
    rendered = json.dumps(encode(rows), indent=2)
    assert decode(json.loads(rendered)) == rows
    Path(path).write_text(rendered)


def selftest_case(case):
    case = Path(case)
    prior = json.loads((case / 'result.json').read_text())
    operation, = prior['operations']
    plan_file, = (case / 'data/continuations').rglob('plan.json')
    plan = json.loads(plan_file.read_text())
    rows, total = read_hermes_state(plan['target_home'], operation['target_session_id'])
    assert total == 1
    expected = [{'role': t['role'], 'content': '\n'.join(block['text'] for block in t['blocks'])} for t in plan['expected']['turns']]
    assert [{'role': row['role'], 'content': row['content']} for row in rows] == expected
    assert decode(json.loads(json.dumps(encode(rows)))) == rows
    blobs = [(index, key, value) for index, row in enumerate(rows) for key, value in row.items() if isinstance(value, bytes)]
    assert blobs, 'Actual BLOB regression fixture required'
    altered = [dict(row) for row in rows]
    index, key, value = blobs[0]
    altered[index][key] = value + b'changed'
    assert encode(altered) != encode(rows) and altered != rows
    result = {'exactRoundtrip': True, 'actualBlobCount': len(blobs), 'changedBlobDetected': True,
              'modelRequests': 0, 'readOnly': True}
    (case / 'sqlite-evidence-selftest.json').write_text(json.dumps(result, indent=2))
    return result


if __name__ == '__main__':
    import sys
    print(json.dumps(selftest_case(sys.argv[1])))
