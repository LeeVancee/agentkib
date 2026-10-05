"""Official Hermes resumed synthetic history against loopback-only once relay."""
import http.server,json,os,signal,sqlite3,subprocess,sys,threading,time,hashlib
from pathlib import Path
from cpa_once_relay import OnceRelay,MODEL
case, original=map(lambda x:Path(x).resolve(),sys.argv[1:3]);case.mkdir(mode=0o700)
mode=sys.argv[3] if len(sys.argv)>3 else "500"
source_hash=hashlib.sha256((original/"hermes/state.db").read_bytes()).hexdigest()
prior=json.loads((original/'result.json').read_text());plan=json.loads(next((original/'data/continuations').rglob('plan.json')).read_text());sid=prior['operations'][0]['target_session_id']
workspace=case/'workspace';workspace.mkdir();home=case/'hermes';home.mkdir()
with sqlite3.connect('file:'+str(original/'hermes/state.db')+'?mode=ro',uri=True) as source,sqlite3.connect(home/'state.db') as target:source.backup(target)
history=[{'role':t['role'],'text':'\n'.join(b['text'] for b in t['blocks'])} for t in plan['expected']['turns']]
prompt='Recall the exact random marker and complete project storage decision from our previous history. Reply with those values only. Do not use tools.'
requests=[]
class Mock(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  requests.append(self.rfile.read(int(self.headers['content-length'])))
  assert self.headers['Authorization']=='Bearer mock-only-relay-key'
  if mode=='network':self.connection.close();return
  if mode=='redirect':
   self.send_response(307);self.send_header('Location',f'http://127.0.0.1:{self.server.server_port}/bypass');self.end_headers();return
  self.send_response(429 if mode=='429' else 200 if mode=='stream' else 500)
  self.send_header('content-type','text/event-stream' if mode=='stream' else 'application/json');self.end_headers()
  if mode=='stream':self.wfile.write(b'data: {"id":"x","choices":[]}\n\n');self.wfile.flush();self.connection.close();return
  self.wfile.write(b'{"error":{"message":"mock failure"}}')
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Mock);threading.Thread(target=server.serve_forever,daemon=True).start()
contract=case/'contract.json';contract.write_text(json.dumps({'endpoint':f'http://127.0.0.1:{server.server_port}/v1/chat/completions','model':MODEL,'stream':True,'sessionId':sid,'route':f'/session/{sid}/v1/chat/completions','history':history,'prompt':prompt}))
relay=OnceRelay(contract,'mock-only-relay-key',offline=True).start()
config={'model':{'provider':'agentkib-cpa','default':MODEL,'base_url':relay.base_url},'providers':{'agentkib-cpa':{'base_url':relay.base_url,'key_env':'AGENTKIB_QA_CPA_KEY','default_model':MODEL,'api_mode':'chat_completions'}},'toolsets':[],'platform_toolsets':{'cli':[]},'mcp_servers':{},'agent':{'api_max_retries':1,'auto_recovery_cycles':0},'compression':{'enabled':False},'memory':{'memory_enabled':False,'user_profile_enabled':False}}
(home/'config.yaml').write_text(json.dumps(config))
env={'HOME':str(case/'home'),'HERMES_HOME':str(home),'PATH':'/opt/homebrew/bin:/usr/bin:/bin','TERM':'xterm-256color','AGENTKIB_QA_CPA_KEY':'mock-only-relay-key','OPENAI_BASE_URL':relay.base_url,'HERMES_IGNORE_RULES':'1'}
for key in ('DATA','CONFIG','CACHE','STATE'):env[f'XDG_{key}_HOME']=str(case/key.lower())
child=subprocess.Popen([plan['executable'],'--profile','default','chat','--resume',sid,'--no-restore-cwd','--model',MODEL,'--provider','agentkib-cpa','--query-file','-','--oneshot','--format','stream-json','--ignore-rules'],env=env,cwd=workspace,stdin=subprocess.PIPE,stdout=(case/'stdout').open('w'),stderr=(case/'stderr').open('w'),start_new_session=True)
child.stdin.write(prompt.encode());child.stdin.close();deadline=time.monotonic()+35
try:
 while child.poll() is None and time.monotonic()<deadline:
  if (case/'relay-events.jsonl').exists():
   events=[json.loads(line) for line in (case/'relay-events.jsonl').read_text().splitlines()]
   if any(e['event']=='blocked' and e.get('tokenConsumed') for e in events):break
  time.sleep(.1)
finally:
 if child.poll() is None:
  os.killpg(child.pid,signal.SIGTERM)
  try:child.wait(timeout=3)
  except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=3)
 relay.close();server.shutdown();server.server_close()
assert len(requests)==1
assert hashlib.sha256((original/'hermes/state.db').read_bytes()).hexdigest()==source_hash
for path in case.rglob('*'):
 if path.is_file():
  with path.open('rb') as f:
   overlap=b''
   while chunk:=f.read(1024*1024):
    combined=overlap+chunk;assert b'mock-only-relay-key' not in combined;overlap=combined[-30:]
result={'mode':mode,'mockUpstreamRequests':len(requests),'cliExitCode':child.returncode,'realCPARequests':0,'sourceDatabaseUnchanged':True,'credentialNotPersisted':True};(case/'result.json').write_text(json.dumps(result));print(json.dumps(result))
