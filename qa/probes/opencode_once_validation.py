"""Pure validation for single-call OpenCode QA; importing this module never sends."""
import copy
import hashlib
import json
from pathlib import Path
import sys


def validate_plan(prior, plan_bytes, receipt, *, expected_model=None):
    for name in ('first', 'repeat', 'repeatAfterRestart'):
        assert prior[name]['status'] == 'launched'
    operation, = prior['operations']
    restarted, = prior['afterRestart']
    assert operation == restarted and operation['status'] == 'launched'
    launch = operation['launch_request']
    digest = hashlib.sha256(plan_bytes).hexdigest()
    assert digest == launch['plan_hash'] == receipt['plan_hash']
    plan = json.loads(plan_bytes)
    assert plan['schema_version'] == receipt['schema_version'] == 1
    assert plan['target_agent'] == prior['target'] == launch['target_agent'] == 'opencode'
    assert plan['operation_id'] == launch['operation_id']
    assert plan['workspace_id'] == launch['workspace_id']
    assert plan['target_session_id'] == receipt['target_session_id'] == operation['target_session_id']
    assert receipt['verified'] is True and receipt['launched'] is True
    assert plan['version'] == '1.18.32'
    if expected_model is None:
        expected_model = {'provider_id': 'opencode', 'model_id': 'big-pickle'}
    assert plan['model'] == expected_model
    return plan


def validate_export(plan, exported):
    assert exported['info']['id'] == plan['target_session_id']
    assert exported['info']['directory'] == plan['workspace']
    expected = []
    for turn in plan['expected']['turns']:
        assert all(block['type'] == 'text' for block in turn['blocks'])
        expected.append({'role': turn['role'], 'text': '\n'.join(block['text'] for block in turn['blocks'])})
    actual = []
    for row in exported['messages']:
        assert row['info']['sessionID'] == plan['target_session_id']
        assert all(part['type'] == 'text' and part['sessionID'] == plan['target_session_id'] for part in row['parts'])
        actual.append({'role': row['info']['role'], 'text': '\n'.join(part['text'] for part in row['parts'])})
    assert actual == expected, 'Full native history differs from reviewed plan projection'
    return actual


def validate_evidence(case):
    case = Path(case)
    prior = json.loads((case / 'result.json').read_text())
    plan_file, = (case / 'data/continuations').rglob('plan.json')
    plan_bytes = plan_file.read_bytes()
    receipt = json.loads(plan_file.with_name('receipt.json').read_text())
    plan = validate_plan(prior, plan_bytes, receipt)
    attempt = case / 'official-big-pickle-once-2026-09-30'
    before = json.loads((attempt / 'before-export.json').read_text())
    validate_export(plan, before)
    bad_export = copy.deepcopy(before)
    bad_export['messages'][0]['parts'][0]['text'] += ' external text'
    bad_receipt = dict(receipt, target_session_id='ses_wrong')
    for fn in (lambda: validate_export(plan, bad_export),
               lambda: validate_plan(prior, plan_bytes + b' ', receipt),
               lambda: validate_plan(prior, plan_bytes, bad_receipt)):
        try:
            fn()
        except AssertionError:
            continue
        raise AssertionError('Invalid history or operation accepted')
    result = {'exactPreRequestProjection': True, 'planHashAndOperationVerified': True,
              'negativeCases': 3, 'readOnlyEvidenceCheck': True}
    (attempt / 'preflight-evidence-validation.json').write_text(json.dumps(result, indent=2))
    return result


if __name__ == '__main__':
    print(json.dumps(validate_evidence(sys.argv[1])))
