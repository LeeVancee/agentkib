"""Pinned native OpenClaw with synthetic state and process-only mock credential."""
import hashlib,http.client,http.server,json,os,shutil,signal,sqlite3,subprocess,sys,threading,time
from pathlib import Path
from cpa_once_relay import MODEL
from openclaw_mock_projection import OpenClawMockRelay
from qa_owned_cli import run_owned_cli
case,original=map(lambda x:Path(x).resolve(),sys.argv[1:3]);case.mkdir(mode=0o700);mode=sys.argv[3] if len(sys.argv)>3 else '500'
prior=json.loads((original/'result.json').read_text());plan=json.loads(next((original/'data/continuations').rglob('plan.json')).read_text());sid=prior['operations'][0]['target_session_id']
workspace=case/'workspace';workspace.mkdir();state=case/'openclaw';state.mkdir();source_hashes={}
for src in (original/'openclaw').rglob('*'):
 if not src.is_file() or src.name.endswith(('-wal','-shm')) or 'lock' in src.name:continue
 dst=state/src.relative_to(original/'openclaw');dst.parent.mkdir(parents=True,exist_ok=True)
 if src.suffix in ('.sqlite','.db') and src.read_bytes()[:16]==b'SQLite format 3\0':
  source_hashes[str(src)]=hashlib.sha256(src.read_bytes()).hexdigest()
  with sqlite3.connect('file:'+str(src)+'?mode=ro',uri=True) as source,sqlite3.connect(dst) as target:source.backup(target)
 else:shutil.copyfile(src,dst)
history=[{'role':t['role'],'text':'\n'.join(b['text'] for b in t['blocks'])} for t in plan['expected']['turns']]
prompt='Recall the exact random marker and complete project storage decision from our previous history. Reply with those values only. Do not use tools.'
requests=[]
class Mock(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  requests.append(self.rfile.read(int(self.headers['content-length'])))
  assert self.headers['Authorization']=='Bearer mock-only-relay-key'
  if mode=='network':self.connection.close();return
  if mode=='redirect':self.send_response(307);self.send_header('Location',f'http://127.0.0.1:{self.server.server_port}/bypass');self.end_headers();return
  self.send_response(429 if mode=='429' else 200 if mode=='stream' else 500);self.send_header('content-type','text/event-stream' if mode=='stream' else 'application/json');self.end_headers()
  if mode=='stream':self.wfile.write(b'data: {"id":"x","choices":[]}\n\n');self.wfile.flush();self.connection.close();return
  self.wfile.write(b'{"error":{"message":"mock failure"}}')
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Mock);threading.Thread(target=server.serve_forever,daemon=True).start()
contract=case/'contract.json';contract.write_text(json.dumps({'endpoint':f'http://127.0.0.1:{server.server_port}/v1/chat/completions','model':MODEL,'stream':True,'sessionId':sid,'route':f'/session/{sid}/v1/chat/completions','history':history,'prompt':prompt}))
c=json.loads(contract.read_text());c.update(offlineOpenClawVersion='2026.9.6', historicalEnvelope='[Wed 2026-09-30 20:00 GMT+8] ', startedAt=time.time(), runtimeLine=f'Runtime: agent=main | session=agent:main:agentkib:{sid} | sessionId={sid} | host=MacBook Pro | os=macOS 27.0.1 (arm64) | node=v26.9.0 | active_node=unknown | model=agentkib-cpa/{MODEL} | default_model=agentkib-cpa/{MODEL}');contract.write_text(json.dumps(c))
relay=OpenClawMockRelay(contract,'mock-only-relay-key').start()
config={'gateway':{'mode':'local','bind':'loopback','auth':{'mode':'none'}},'agents':{'defaults':{'workspace':str(workspace),'skipBootstrap':True,'model':{'primary':'agentkib-cpa/'+MODEL}},'entries':{'main':{'workspace':str(workspace)}}},'plugins':{'enabled':False},'tools':{'deny':['*']},'models':{'mode':'replace','providers':{'agentkib-cpa':{'baseUrl':relay.base_url,'apiKey':{'source':'env','provider':'default','id':'AGENTKIB_QA_CPA_KEY'},'api':'openai-completions','models':[{'id':MODEL,'name':'Selected CPA Opus','reasoning':False,'input':['text'],'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0},'contextWindow':200000,'maxTokens':4096,'compat':{'supportsTools':False}}]}}}}
config_path=state/'openclaw.json';original_config=config_path.read_bytes();modified_config=json.dumps(config).encode()
env={'HOME':str(case/'home'),'OPENCLAW_STATE_DIR':str(state),'OPENCLAW_CONFIG_PATH':str(state/'openclaw.json'),'PATH':'/opt/homebrew/bin:/usr/bin:/bin','TERM':'xterm-256color','AGENTKIB_QA_CPA_KEY':'mock-only-relay-key'}
for key in ('DATA','CONFIG','CACHE','STATE'):env[f'XDG_{key}_HOME']=str(case/key.lower())
args=[plan['executable'],'agent','--local','--agent','main','--session-id',sid,'--message',prompt,'--json','--thinking','off','--timeout','30']
result={'mode':mode,'realCPARequests':0}
def stop():
 if (case/'relay-events.jsonl').exists():
  events=[json.loads(line) for line in (case/'relay-events.jsonl').read_text().splitlines()]
  return any(e['event']=='blocked' and e.get('tokenConsumed') for e in events)
 return False
try:
 with (case/'stdout').open('w') as stdout,(case/'stderr').open('w') as stderr:
  run_owned_cli(args,env=env,cwd=workspace,config=config_path,original=original_config,modified=modified_config,prompt='',stdout=stdout,stderr=stderr,result=result,should_stop=stop,timeout=40)
finally:
 relay.close()
 # New relay instance retains the consumed on-disk token. Same request cannot
 # cross to the still-running upstream mock after a guard restart.
 if (case/'reviewed-wire-request.json').exists():
  restarted=OpenClawMockRelay(contract,'mock-only-relay-key').start()
  try:
   conn=http.client.HTTPConnection('127.0.0.1',restarted.server.server_port,timeout=3)
   conn.request('POST',c['route'],body=(case/'reviewed-wire-request.json').read_bytes(),headers={'Authorization':'Bearer mock-only-relay-key','content-type':'application/json'})
   response=conn.getresponse();assert response.status==409;response.read();conn.close()
   result['relayRestartReplayBlocked']=True
  finally:restarted.close()
 server.shutdown();server.server_close()
result['relayStopped']=not relay.thread.is_alive()
assert all(hashlib.sha256(Path(path).read_bytes()).hexdigest()==value for path,value in source_hashes.items())
result['sourceDatabasesUnchanged']=True
# Official fixed-version read-only accessor in a fresh Node process; no model.
read_script = """
import {pathToFileURL} from 'node:url';
const p=JSON.parse(process.argv[1]);
const load=n=>import(pathToFileURL(p.package+'/dist/'+n));
const {n:readOnly}=await load('openclaw-agent-db-readonly-IBx2zWDG.mjs');
const {l:events}=await load('session-accessor.sqlite-read-DG0i0-yW.mjs');
const out=readOnly(d=>({events:events(d,p.sid),count:d.db.prepare('SELECT COUNT(*) AS n FROM session_nodes').get().n,matches:d.db.prepare('SELECT COUNT(*) AS n FROM session_nodes WHERE current_session_id=?').get(p.sid).n}),{agentId:'main',env:process.env,path:p.database});
if(!out.found)throw Error('Missing native database');console.log(JSON.stringify(out.value));
"""
spec={'package':plan['openclaw']['package'],'sid':sid,'database':str(state/'agents/main/agent/openclaw-agent.sqlite')}
def read_native():
 return json.loads(subprocess.run([plan['openclaw']['node'],'--input-type=module','-e',read_script,json.dumps(spec)],env={k:v for k,v in env.items() if k!='AGENTKIB_QA_CPA_KEY'},cwd=workspace,check=True,capture_output=True,timeout=20).stdout)
native=read_native();expected=json.loads(plan['payload'])
assert native['events'][:len(expected)]==expected
assert native['matches']==1 and native['count']==6
assert read_native()==native
(case/'native-after-restart.json').write_text(json.dumps(native,indent=2))
result.update(importedNativePrefixUnchanged=True,nativeSessionCount=native['count'],importedSessionCount=1,readOnlyRestartStable=True)

result['mockUpstreamRequests']=len(requests)
events=[json.loads(line) for line in (case/'relay-events.jsonl').read_text().splitlines()]
result['singleDispatchVerified']=len(requests)==1 and sum(e['event']=='dispatch' for e in events)==1
expected_status={'500':500,'429':429,'redirect':307,'stream':200}.get(mode)
assert [e['status'] for e in events if e['event']=='response']==([] if expected_status is None else [expected_status])
result['expectedFailureObserved']=True
result['guardTokenPreserved']=(case/'dispatch-token.json').is_file()
result['wireRequestMatchesForwarded']=bool(requests) and requests[0]==(case/'reviewed-wire-request.json').read_bytes()
result['credentialNotPersisted']=True
for path in case.rglob('*'):
 if not path.is_file():continue
 with path.open('rb') as file:
  previous=b''
  while chunk:=file.read(1024*1024):
   assert b'mock-only-relay-key' not in previous+chunk, str(path)
   previous=chunk[-64:]
result['passed']=all(result.get(k) for k in ('singleDispatchVerified','guardTokenPreserved','wireRequestMatchesForwarded','relayRestartReplayBlocked','credentialNotPersisted','isolatedConfigRestored','ownedCliCleanupCompleted','relayStopped')) and result['cliExitCode']!=0
(case/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
assert result['passed'], 'Native mock did not reach and safely stop the expected single dispatch'
