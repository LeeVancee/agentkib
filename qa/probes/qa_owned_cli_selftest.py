"""Cancel a supervisor while its independent child emits local mock dispatches."""
import json,os,signal,subprocess,sys,time
from pathlib import Path
from qa_owned_cli import run_owned_cli


def worker(root):
    config=root/'config';original=config.read_bytes();result={}
    # The child owns a distinct process group and ignores TERM to exercise KILL.
    code='''import os,signal,time,pathlib
p=pathlib.Path(os.environ["QA_ONLY_DIR"])
signal.signal(signal.SIGTERM,signal.SIG_IGN)
(p/"token").write_text("consumed")
while True:
 with (p/"mock-dispatches").open("a") as f:f.write("dispatch\\n")
 time.sleep(0.03)
'''
    try:
        run_owned_cli([sys.executable,'-c',code],env=dict(os.environ,QA_ONLY_DIR=str(root)),cwd=root,
                      config=config,original=original,modified=b'modified',prompt='',stdout=subprocess.DEVNULL,
                      stderr=subprocess.DEVNULL,result=result,should_stop=lambda:False,timeout=60)
    finally:
        (root/'worker-result.json').write_text(json.dumps(result))


if sys.argv[1]=='--worker':
    worker(Path(sys.argv[2]));raise SystemExit
root=Path(sys.argv[1]).resolve();root.mkdir(mode=0o700)
results=[]
for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):
    case=root/str(sig);case.mkdir(mode=0o700);(case/'config').write_bytes(b'original')
    child=subprocess.Popen([sys.executable,__file__,'--worker',str(case)],start_new_session=True)
    deadline=time.monotonic()+10
    while not (case/'token').exists() and child.poll() is None and time.monotonic()<deadline:time.sleep(0.02)
    assert (case/'token').exists()
    os.killpg(child.pid,sig);child.wait(timeout=8)
    r=json.loads((case/'worker-result.json').read_text());assert r['ownedCliCleanupCompleted'] and r['isolatedConfigRestored']
    assert (case/'config').read_bytes()==b'original' and (case/'token').read_text()=='consumed'
    first=(case/'mock-dispatches').read_bytes();time.sleep(0.2);assert first==(case/'mock-dispatches').read_bytes()
    try:os.kill(r['ownedCliPid'],0)
    except ProcessLookupError:pass
    else:raise AssertionError('owned child survived supervisor cleanup')
    results.append({'signal':int(sig),'cleanup':True,'configRestored':True,'tokenRetained':True,'noDispatchAfterCleanup':True})
(root/'result.json').write_text(json.dumps(results,indent=2));print(json.dumps(results))

# Deterministic process-exit race and bounded-wait failure; no real signals/PIDs.
import io
from unittest.mock import patch
class RaceChild:
    pid=999999
    returncode=0
    def __init__(self, stuck=False):self.stdin=io.BytesIO();self.waits=0;self.stuck=stuck
    def poll(self):return None
    def wait(self, timeout):
        assert timeout == 3
        self.waits += 1
        if self.waits == 1 or self.stuck:raise subprocess.TimeoutExpired('fixture', timeout)
        return 0
for stuck in (False, True):
    case=root/('stuck' if stuck else 'exit-race');case.mkdir();config=case/'config';config.write_bytes(b'original');r={}
    with patch('qa_owned_cli.subprocess.Popen',return_value=RaceChild(stuck)), patch('qa_owned_cli.os.killpg',side_effect=ProcessLookupError):
        try:
            run_owned_cli(['fake'],env={},cwd=case,config=config,original=b'original',modified=b'modified',prompt='',
                          stdout=None,stderr=None,result=r,should_stop=lambda:True)
        except subprocess.TimeoutExpired:
            assert stuck
        else:
            assert not stuck
    assert config.read_bytes()==b'original' and r['isolatedConfigRestored']
    assert bool(r.get('ownedCliCleanupCompleted')) != stuck
print(json.dumps({'exitRace':True,'boundedWaitFailureStillRestoredConfig':True}))

# A first signal during normal cleanup must survive config restoration and fail
# the caller; later signals cannot interrupt that restoration.
case=root/'first-cancel-during-cleanup';case.mkdir();config=case/'config';config.write_bytes(b'original');r={}
handlers={}
def install(sig, callback):
    old=handlers.get(sig, signal.SIG_DFL);handlers[sig]=callback;return old
def cleanup_signal(_pid, _sig):
    if _sig == signal.SIGTERM:
        handlers[signal.SIGTERM](signal.SIGTERM,None)
        handlers[signal.SIGINT](signal.SIGINT,None)
class ExitedChild(RaceChild):
    def poll(self):return 0
    def wait(self,timeout):return 0
with patch('qa_owned_cli.signal.signal',side_effect=install), patch('qa_owned_cli.subprocess.Popen',return_value=ExitedChild()), patch('qa_owned_cli.os.killpg',side_effect=cleanup_signal):
    try:
        run_owned_cli(['fake'],env={},cwd=case,config=config,original=b'original',modified=b'modified',prompt='',
                      stdout=None,stderr=None,result=r,should_stop=lambda:False)
    except SystemExit as exc:
        assert exc.code == 128+signal.SIGTERM
    else:raise AssertionError('First cleanup cancellation was lost')
assert config.read_bytes()==b'original' and r['isolatedConfigRestored'] and r['ownedCliCleanupCompleted']
assert r['cancellationSignals']==[signal.SIGTERM,signal.SIGINT]
print(json.dumps({'firstCleanupCancellationPreserved':True,'subsequentSignalsDeferred':True}))
