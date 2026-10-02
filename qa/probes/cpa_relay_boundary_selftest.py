"""Proof and delayed-connect races with injected CPA transport; no CPA network."""
import importlib.util,json,os,threading,time,types,http.client
from pathlib import Path
from unittest.mock import patch
import sys
from cpa_once_relay import OnceRelay,MODEL,POLICY,verify_window

root=Path(sys.argv[1]).resolve();root.mkdir(mode=0o700)
proof=root/'journal.json';base={'schemaVersion':1,'status':'open','endpoint':'http://127.0.0.1:8317','model':MODEL,'expiresAt':'2099-01-01T00:00:00Z','retryPolicy':POLICY}
proof.write_text(json.dumps(base));proof.chmod(0o600)
cpa=root/'safe-config';cpa.write_text(json.dumps({'retry':0}));module=types.SimpleNamespace(CPA=cpa,yaml=types.SimpleNamespace(safe_load=json.loads),FIELDS={('retry',):0},lookup=lambda c,k:c['retry'],check_overrides=lambda:None,cc_read=lambda:json.dumps({'enabled':False}))
spec=types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda _:None))
with patch('cpa_once_relay.importlib.util.spec_from_file_location',return_value=spec),patch('cpa_once_relay.importlib.util.module_from_spec',return_value=module):
 verify_window(proof)
 for kind in ('closed','quota','actual-retry','public-proof','symlink','override'):
  proof.write_text(json.dumps(base));proof.chmod(0o600);cpa.write_text('{"retry":0}');path=proof;module.check_overrides=lambda:None
  if kind=='closed':proof.write_text(json.dumps(dict(base,status='closed')))
  if kind=='quota':proof.write_text(json.dumps(dict(base,retryPolicy=dict(POLICY,quotaSwitchProject=True))))
  if kind=='actual-retry':cpa.write_text('{"retry":1}')
  if kind=='public-proof':proof.chmod(0o644)
  if kind=='symlink':path=root/'link';path.symlink_to(proof)
  if kind=='override':
   def fail():raise RuntimeError('private test data')
   module.check_overrides=fail
  try:verify_window(path)
  except Exception as e:assert 'private test data' not in str(e)
  else:raise AssertionError('Invalid proof accepted: '+kind)

history=[{'role':'user','text':'marker M'},{'role':'assistant','text':'decision D'}];prompt='Recall.'
body=json.dumps({'model':MODEL,'stream':True,'messages':[{'role':x['role'],'content':x['text']} for x in history]+[{'role':'user','content':prompt}]})
original_connect=http.client.HTTPConnection.connect;original_request=http.client.HTTPConnection.request
results=[]
for kind in ('close-during-connect','proof-closes-during-connect'):
 case=root/kind;case.mkdir(mode=0o700);contract=case/'contract.json';contract.write_text(json.dumps({'endpoint':'http://127.0.0.1:8317/v1/chat/completions','model':MODEL,'stream':True,'sessionId':'sid','route':'/session/sid/v1/chat/completions','history':history,'prompt':prompt,'retryWindow':str(proof)}))
 entered=threading.Event();release=threading.Event();active=[True];dispatches=[]
 class Socket:
  def settimeout(self,_):pass
  def shutdown(self,_):pass
  def close(self):pass
 def delayed(self):
  if self.port!=8317:return original_connect(self)
  entered.set();assert release.wait(5);self.sock=Socket()
 def send(self,*args,**kwargs):
  if self.port!=8317:return original_request(self,*args,**kwargs)
  dispatches.append(1);raise AssertionError('Fake transport forbids CPA request')
 def window(_):assert active[0]
 with patch('cpa_once_relay.verify_window',window),patch('http.client.HTTPConnection.connect',delayed),patch('http.client.HTTPConnection.request',send):
  relay=OnceRelay(contract,'mock-key').start()
  def client():
   conn=http.client.HTTPConnection('127.0.0.1',relay.server.server_port,timeout=5)
   try:
    conn.request('POST','/session/sid/v1/chat/completions',body=body,headers={'Authorization':'Bearer mock-key'});conn.getresponse().read()
   except (OSError,http.client.HTTPException):pass
   finally:conn.close()
  thread=threading.Thread(target=client);thread.start();assert entered.wait(5)
  if kind=='close-during-connect':
   started=time.monotonic();relay.close();assert time.monotonic()-started<2
  else:active[0]=False
  release.set();thread.join(timeout=5);assert not thread.is_alive()
  if kind!='close-during-connect':relay.close()
 assert dispatches==[] and contract.with_name('dispatch-token.json').exists()
 results.append({'case':kind,'upstreamRequests':0,'tokenRetained':True})
result={'proofNegativeCases':6,'races':results,'realCPARequests':0};(root/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
