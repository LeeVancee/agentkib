#!/usr/bin/env python3
"""Native Plan/Goal acceptance with real CLI + loopback synthetic model.

No account credentials or real workspace are inherited. The model's deterministic
responses verify protocol mechanics, not reasoning quality or real-model safety.
Usage: python3 codex_native_plan_goals.py /absolute/path/to/codex [...]
"""
import io
import json
import pathlib
import queue
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import ThreadingHTTPServer

from codex_native_writer_lock import Model, Peer


class CapturingModel(Model):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        self.server.requests.append(json.loads(body))
        time.sleep(self.server.delay)
        # Bound a broken native continuation loop even if its budget guard fails.
        if len(self.server.requests) > 40:
            self.send_error(503, 'Synthetic model request limit')
            return
        if not self.server.ask_once and not self.server.plan_once:
            self.rfile = io.BytesIO(body)
            return super().do_POST()
        self.server.ask_once = False
        item = {
            'id': 'fc_question', 'type': 'function_call',
            'name': 'request_user_input', 'call_id': 'question_call',
            'arguments': json.dumps({'questions': [{
                'id': 'fixture', 'header': 'Offline', 'question': 'Synthetic choice',
                'options': [{'label': 'One', 'description': 'First fixture'},
                            {'label': 'Two', 'description': 'Second fixture'}],
            }]}), 'status': 'completed',
        }
        if self.server.plan_once:
            self.server.plan_once = False
            item = {'id': 'msg_plan', 'type': 'message', 'role': 'assistant', 'status': 'completed', 'content': [{'type': 'output_text', 'text': '<proposed_plan>\n# Synthetic plan\n\n1. Read fixture.\n2. Report findings.\n</proposed_plan>', 'annotations': []}]}
        rid = 'resp_' + uuid.uuid4().hex
        events = [
            ('response.created', {'response': {'id': rid, 'object': 'response', 'status': 'in_progress', 'output': []}}),
            ('response.output_item.added', {'output_index': 0, 'item': {**item, 'status': 'in_progress'}}),
            ('response.output_item.done', {'output_index': 0, 'item': item}),
            ('response.completed', {'response': {'id': rid, 'object': 'response', 'status': 'completed', 'output': [item], 'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}}),
        ]
        if item['type'] == 'message':
            events.insert(2, ('response.output_text.delta', {'item_id': item['id'], 'output_index': 0, 'content_index': 0, 'delta': item['content'][0]['text']}))
        data = ''.join('event: ' + event + '\ndata: ' + json.dumps({'type': event, **payload}) + '\n\n' for event, payload in events).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def wait_event(peer, method):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        for index, event in enumerate(peer.events):
            if event.get('method') == method:
                return peer.events.pop(index)
        try:
            event = peer.messages.get(timeout=max(.1, deadline - time.monotonic()))
        except queue.Empty:
            break
        assert event is not None, 'app-server closed'
        peer.events.append(event)
    raise AssertionError('No native event: ' + method)


def mode_settings(mode):
    # Null is essential: Codex itself resolves its built-in mode instructions.
    return {'mode': mode, 'settings': {'model': 'gpt-5.5', 'reasoning_effort': 'low', 'developer_instructions': None}}


def run(executable):
    result = {'binary': executable, 'version': subprocess.check_output([executable, '--version'], text=True).strip(),
              'isolatedHome': True, 'loopbackSyntheticModel': True}
    with tempfile.TemporaryDirectory(prefix='agentkib-native-plan-goals-') as tmp:
        root = pathlib.Path(tmp)
        for name in ['user', 'codex', 'workspace', 'tmp']:
            (root / name).mkdir()
        server = ThreadingHTTPServer(('127.0.0.1', 0), CapturingModel)
        server.requests = []
        server.ask_once = False
        server.delay = 0
        server.plan_once = False
        threading.Thread(target=server.serve_forever, daemon=True).start()
        peer = Peer(executable, root, server.server_port)

        def call(method, **params):
            reply = peer.call(method, params)
            assert 'result' in reply, (method, reply)
            return reply['result']

        def goal(**params):
            return call('thread/goal/set', threadId=thread_id, **params)['goal']

        def get_goal():
            return call('thread/goal/get', threadId=thread_id)['goal']

        def turn(mode=None):
            params = {'threadId': thread_id, 'input': [{'type': 'text', 'text': 'Synthetic offline turn. No commands or file changes.'}]}
            if mode is not None:
                params.update(model='gpt-5.5', effort='low', collaborationMode=mode_settings(mode))
            return call('turn/start', **params)

        stage = 'mode-directory'
        try:
            modes = call('collaborationMode/list')['data']
            assert {'plan', 'default'} <= {m['mode'] for m in modes}, modes
            result['nativeModeDirectory'] = modes
            started = call('thread/start', cwd=str(root / 'workspace'), model='gpt-5.5', approvalPolicy='on-request', sandbox='workspace-write')
            thread_id = started['thread']['id']
            stage = 'turn-mode-native-readback'
            result['turnModeReadbacks'] = []
            for mode in ['plan', 'default', 'plan']:
                turn(mode)
                peer.completed()
                event = wait_event(peer, 'thread/settings/updated')['params']['threadSettings']
                native = event['collaborationMode']
                assert native['mode'] == mode, native['mode']
                assert event['model'] == native['settings']['model'] == server.requests[-1]['model'] == 'gpt-5.5'
                assert event['effort'] == native['settings']['reasoning_effort'] == server.requests[-1]['reasoning']['effort'] == 'low'
                assert native['settings']['developer_instructions'], 'Native built-in instructions missing'
                # Do not persist vendor prompt text as our own mode implementation.
                result['turnModeReadbacks'].append({'mode': mode, 'model': event['model'], 'effort': event['effort'], 'nativeInstructionsResolvedFromNull': True})
            stage = 'native-plan-item-and-delta'
            server.plan_once = True
            turn('plan')
            peer.completed()
            plan_delta = wait_event(peer, 'item/plan/delta')['params']
            plan_items = [event['params']['item'] for event in peer.events if event.get('method') == 'item/completed' and event.get('params', {}).get('item', {}).get('type') == 'plan']
            assert len(plan_items) == 1 and plan_items[0]['id'] == plan_delta['itemId']
            assert plan_items[0]['text'] == plan_delta['delta'] == '# Synthetic plan\n\n1. Read fixture.\n2. Report findings.\n'
            history = call('thread/read', threadId=thread_id, includeTurns=True)['thread']['turns']
            assert any(item.get('type') == 'plan' and item.get('text') == plan_delta['delta'] for native_turn in history for item in native_turn['items'])
            result['nativePlanItemDeltaAndHistory'] = True
            stage = 'plan-question-native-resolution'
            server.ask_once = True
            turn('plan')
            request = wait_event(peer, 'item/tool/requestUserInput')
            peer.write({'id': request['id'], 'result': {'answers': {'fixture': {'answers': ['One']}}}})
            peer.completed()
            resolved = wait_event(peer, 'serverRequest/resolved')
            assert resolved['params']['requestId'] == request['id']
            result['nativePlanQuestionAnsweredAndResolved'] = True
            stage = 'mode-restart-and-resume'
            # Resume exposes no collaboration mode. Observe; do not guess from local state.
            peer.close()
            peer = Peer(executable, root, server.server_port)
            resumed = call('thread/resume', threadId=thread_id)
            assert resumed['thread']['id'] == thread_id
            result['resumeReturnsMode'] = 'collaborationMode' in resumed
            turn()
            peer.completed()
            developers = [json.dumps(m.get('content', '')) for m in server.requests[-1].get('input', []) if m.get('role') == 'developer']
            result['resumeWithoutExplicitModeHasEmptyNativeModeInstruction'] = any('<collaboration_mode></collaboration_mode>' in text for text in developers)
            stage = 'explicit-plan-after-resume-event'
            turn('plan')
            peer.completed()
            if resumed.get('collaborationMode') is not None:
                assert resumed['collaborationMode']['mode'] == 'plan'
                result['planAfterResumeConfirmationSource'] = 'native-resume-response'
            else:
                event = wait_event(peer, 'thread/settings/updated')['params']['threadSettings']
                assert event['collaborationMode']['mode'] == 'plan'
                result['planAfterResumeConfirmationSource'] = 'native-settings-event-after-explicit-turn'
            turn('default')
            peer.completed()

            stage = 'goal-update-budget-and-status-semantics'
            created = goal(objective='Offline budget fixture', status='paused', tokenBudget=100)
            assert created['status'] == 'paused'
            changed = goal(objective='Edited paused fixture')
            assert changed['status'] == 'paused' and changed['tokenBudget'] == 100
            cleared_budget = goal(tokenBudget=None)
            assert cleared_budget['tokenBudget'] is None and cleared_budget['status'] == 'paused'
            blocked = goal(status='blocked', tokenBudget=100)
            assert blocked['status'] == 'blocked'
            changed = goal(objective='Edited blocked fixture')
            assert changed['status'] == 'blocked' and changed['tokenBudget'] == 100
            result['goalOmittedStatusAndBudgetPreserved'] = True
            result['goalExplicitNullClearsBudget'] = True
            result['goalPausedAndBlockedUpdatesDoNotActivate'] = True

            # A tiny explicit budget bounds actual native autonomous continuation.
            stage = 'native-goal-budget-exhaustion'
            active = goal(status='active', tokenBudget=1)
            assert active['status'] == 'active'
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                current = get_goal()
                if current['status'] == 'budgetLimited':
                    break
                time.sleep(.05)
            assert current['status'] == 'budgetLimited' and current['tokensUsed'] > 0, current
            used = current['tokensUsed']
            result['nativeBudgetExhaustion'] = {'status': current['status'], 'tokensUsed': used, 'tokenBudget': current['tokenBudget']}
            changed = goal(objective='Edited after exhaustion', tokenBudget=used + 2)
            assert changed['tokensUsed'] == used and changed['status'] == 'budgetLimited'
            cleared_budget = goal(tokenBudget=None)
            assert cleared_budget['tokensUsed'] == used and cleared_budget['status'] == 'budgetLimited' and cleared_budget['tokenBudget'] is None
            limited = goal(status='active', tokenBudget=1)
            assert limited['status'] == 'budgetLimited' and limited['tokensUsed'] == used
            result['goalUpdatesPreserveNonzeroUsageAndLimitedStatus'] = True
            result['nativeBudgetLimitOverridesRequestedActivation'] = True
            # A limited goal stays limited until explicit activation, even after
            # a budget increase; a pause request is not a limit reset operation.
            raised = goal(tokenBudget=used + 2)
            assert raised['status'] == 'budgetLimited'
            assert goal(status='paused')['status'] == 'budgetLimited'
            active = goal(status='active')
            assert active['status'] in ['active', 'budgetLimited']
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                current = get_goal()
                if current['status'] == 'budgetLimited':
                    break
                time.sleep(.05)
            assert current['status'] == 'budgetLimited' and current['tokensUsed'] > used
            result['limitedGoalNeedsExplicitActivationAfterBudgetIncrease'] = True
            stage = 'goal-restart-and-resume'
            # Native restore must preserve usage and not automatically clear limits.
            peer.close()
            before = len(server.requests)
            peer = Peer(executable, root, server.server_port)
            call('thread/resume', threadId=thread_id)
            restored = get_goal()
            assert restored['status'] == 'budgetLimited' and restored['tokensUsed'] == current['tokensUsed']
            time.sleep(.15)
            assert len(server.requests) == before
            result['limitedGoalUsageSurvivesRestartWithoutContinuation'] = True
            call('thread/goal/clear', threadId=thread_id)
            goal(objective='Paused restore fixture', status='paused', tokenBudget=1)
            peer.close()
            before = len(server.requests)
            peer = Peer(executable, root, server.server_port)
            call('thread/resume', threadId=thread_id)
            assert get_goal()['status'] == 'paused'
            time.sleep(.15)
            assert len(server.requests) == before
            result['pausedGoalSurvivesRestartWithoutContinuation'] = True
            assert goal(status='active')['status'] == 'active'
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                current = get_goal()
                if current['status'] == 'budgetLimited':
                    break
                time.sleep(.05)
            assert current['status'] == 'budgetLimited' and current['tokensUsed'] > 0
            result['nativePausedGoalResumesOnExplicitActivation'] = True
            call('thread/goal/clear', threadId=thread_id)
            assert get_goal() is None
            result['nativeGoalClearReadback'] = True
            stage = 'active-goal-pause-during-native-turn'
            server.delay = .5
            before = len(server.requests)
            goal(objective='Pause during synthetic model response', status='active', tokenBudget=100)
            deadline = time.monotonic() + 5
            while len(server.requests) == before and time.monotonic() < deadline:
                time.sleep(.01)
            assert len(server.requests) > before, 'Goal did not start a native model request'
            assert goal(status='paused')['status'] == 'paused'
            time.sleep(.7)
            paused = get_goal()
            assert paused['status'] == 'paused'
            before = len(server.requests)
            time.sleep(.15)
            assert len(server.requests) == before
            call('thread/goal/clear', threadId=thread_id)
            assert get_goal() is None
            result['activeNativeGoalPauseStopsContinuation'] = True
            result['modelRequestCount'] = len(server.requests)
            result['notCovered'] = ['Official owner/follower UI channel', 'Real model planning quality or mutation restraint', 'Real account usage-limit exhaustion', 'Mobile/public relay']
            result['outcome'] = 'passed'
            return result
        except Exception as error:
            result.update(outcome='failed', failedAt=stage, error=str(error))
            print(json.dumps(result, ensure_ascii=False), flush=True)
            raise
        finally:
            peer.close()
            server.shutdown()
            server.server_close()


if __name__ == '__main__':
    assert len(sys.argv) > 1, 'Pass an explicit Codex executable'
    for binary in sys.argv[1:]:
        print(json.dumps(run(binary), ensure_ascii=False))
