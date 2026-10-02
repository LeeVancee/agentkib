"""Loopback mock only; never uses an existing CPA or model authorization."""
import concurrent.futures,http.client,http.server,json,sys,threading,time,subprocess,os
from pathlib import Path
from cpa_once_relay import OnceRelay,MODEL

root=Path(sys.argv[1]).absolute();root.mkdir(mode=0o700)
requests=[];mode='500'
class Upstream(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  body=self.rfile.read(int(self.headers['content-length']));requests.append(self.path)
  assert self.headers['Authorization']=='Bearer mock-only-relay-key'
  assert self.headers['User-Agent']=='native-fixture-identity'
  if mode=='hold':
   self.send_response(200);self.send_header('content-type','text/event-stream');self.end_headers();self.wfile.flush()
   self.connection.settimeout(5)
   try:self.connection.recv(1)
   except OSError:pass
   return
  if mode=='network':self.connection.close();return
  if mode=='redirect':
   self.send_response(307);self.send_header('Location','/bypass');self.end_headers();return
  self.send_response(429 if mode=='429' else 500 if mode=='500' else 200)
  self.send_header('content-type','text/event-stream' if mode=='stream' else 'application/json');self.end_headers()
  if mode=='stream':self.wfile.write(b'data: partial\n\n');self.wfile.flush();self.connection.close();return
  self.wfile.write(b'{}')
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Upstream)
threading.Thread(target=server.serve_forever,daemon=True).start()
history=[{'role':'user','text':'marker M17'},{'role':'assistant','text':'decision SQLite WAL'}];prompt='Recall marker and decision.'
body=json.dumps({'model':MODEL,'stream':True,'messages':[{'role':x['role'],'content':x['text']} for x in history]+[{'role':'user','content':prompt}]}).encode()

def setup(name):
 d=root/name;d.mkdir(mode=0o700);p=d/'contract.json';p.write_text(json.dumps({'endpoint':f'http://127.0.0.1:{server.server_port}/v1/chat/completions','model':MODEL,'stream':True,'sessionId':'sid_qa','route':'/session/sid_qa/v1/chat/completions','history':history,'prompt':prompt}));return p

def call(relay,payload=body,path='/session/sid_qa/v1/chat/completions'):
 c=http.client.HTTPConnection('127.0.0.1',relay.server.server_port,timeout=3)
 try:
  c.request('POST',path,body=payload,headers={'Authorization':'Bearer mock-only-relay-key','User-Agent':'native-fixture-identity','content-type':'application/json'})
  r=c.getresponse();r.read();return r.status
 except (OSError,http.client.HTTPException):return None
 finally:c.close()
results=[]
try:
 for mode in ('500','429','redirect','network','stream'):
  file=setup(mode);relay=OnceRelay(file,'mock-only-relay-key',offline=True).start();before=len(requests)
  status=call(relay);assert call(relay)==409;relay.close()
  fresh=OnceRelay(file,'mock-only-relay-key',offline=True).start();assert call(fresh)==409;fresh.close()
  assert len(requests)-before==1 and requests[-1]=='/v1/chat/completions'
  if mode=='redirect':assert status==502
  results.append({'case':mode,'upstream':1,'repeatedAndRestartedBlocked':True})
 mode='ok';file=setup('concurrency');relays=[OnceRelay(file,'mock-only-relay-key',offline=True).start() for _ in range(6)];before=len(requests)
 with concurrent.futures.ThreadPoolExecutor() as pool:statuses=list(pool.map(call,relays))
 for relay in relays:relay.close()
 assert len(requests)-before==1 and statuses.count(409)==5;results.append({'case':'six-concurrent-relay-instances','upstream':1})
 file=setup('reject-before-token');relay=OnceRelay(file,'mock-only-relay-key',offline=True).start();before=len(requests)
 changed=json.loads(body);changed['messages'][0]['content']='external change'
 assert call(relay,json.dumps(changed).encode())==409 and call(relay,path='/session/wrong/v1/chat/completions')==409
 assert len(requests)==before and not file.with_name('dispatch-token.json').exists();relay.close();results.append({'case':'changed-history-or-session-route','upstream':0})
 mode='hold';file=setup('cancel-active');relay=OnceRelay(file,'mock-only-relay-key',offline=True).start();before=len(requests)
 thread=threading.Thread(target=call,args=(relay,));thread.start();deadline=time.monotonic()+5
 while len(requests)==before and time.monotonic()<deadline:time.sleep(.01)
 assert len(requests)==before+1;started=time.monotonic();relay.close();thread.join(timeout=3)
 assert not thread.is_alive() and time.monotonic()-started<3 and file.with_name('dispatch-token.json').exists()
 results.append({'case':'close-cancels-active-upstream','upstream':1,'tokenRetained':True})
 mode='ok';file=setup('multiprocess');before=len(requests);children=[];ports=[]
 child_source="from cpa_once_relay import OnceRelay;import sys; r=OnceRelay(sys.argv[1],'mock-only-relay-key',offline=True).start();print(r.server.server_port,flush=True);sys.stdin.read(1);r.close()"
 try:
  for _ in range(4):
   child=subprocess.Popen([sys.executable,'-c',child_source,str(file)],env=dict(os.environ,PYTHONPATH=str(Path(__file__).parent)),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
   children.append(child);ports.append(int(child.stdout.readline()))
  def send_port(port):
   class Proxy:pass
   relay=Proxy();relay.server=Proxy();relay.server.server_port=port;return call(relay)
  with concurrent.futures.ThreadPoolExecutor() as pool:statuses=list(pool.map(send_port,ports))
  assert len(requests)-before==1 and statuses.count(409)==3
 finally:
  for child in children:
   child.stdin.write('x');child.stdin.flush();child.wait(timeout=5)
 results.append({'case':'four-separate-processes','upstream':1})
 for path in root.rglob('*'):
  if path.is_file():assert b'mock-only-relay-key' not in path.read_bytes()
 (root/'result.json').write_text(json.dumps({'passed':True,'cases':results,'realCPARequests':0,'credentialNotPersisted':True},indent=2));print(json.dumps(results))
finally:server.shutdown();server.server_close()
