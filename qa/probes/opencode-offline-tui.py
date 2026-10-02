"""macOS native OpenCode history view with all network denied and no user input."""
import fcntl,json,os,pty,select,signal,struct,subprocess,sys,termios,time
from pathlib import Path
case=Path(sys.argv[1]).resolve();prior=json.loads((case/'result.json').read_text());plan=json.loads(next((case/'data/continuations').rglob('plan.json')).read_text());env=json.loads((case/'environment.json').read_text());sid=prior['operations'][0]['target_session_id']
assert prior['target']=='opencode' and all('API_KEY' not in key and 'TOKEN' not in key for key in env)
env['TERM']='xterm-256color';results=[]
for run in range(2):
 master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',80,200,0,0))
 child=subprocess.Popen(['/usr/bin/sandbox-exec','-p','(version 1)(allow default)(deny network*)',plan['executable'],'--session',sid],env=env,cwd=plan['workspace'],stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave);output=b'';deadline=time.monotonic()+15
 try:
  while child.poll() is None and time.monotonic()<deadline:
   if select.select([master],[],[],.2)[0]:
    try:chunk=os.read(master,65536)
    except OSError:break
    if not chunk:break
    output+=chunk
    if prior['marker'].encode() in output and prior['decision'].encode() in output:break
 finally:
  if child.poll() is None:
   os.killpg(child.pid,signal.SIGTERM)
   try:child.wait(timeout=3)
   except subprocess.TimeoutExpired:
    try:os.killpg(child.pid,signal.SIGKILL)
    except ProcessLookupError:pass
    child.wait(timeout=3)
  os.close(master)
 (case/f'cpa-native-tui-{run}.ansi').write_bytes(output)
 results.append({'run':run,'markerVisible':prior['marker'].encode() in output,'decisionVisible':prior['decision'].encode() in output,'networkDeniedByOS':True,'noInputSent':True,'pid':child.pid,'exitCodeAfterCleanup':child.returncode})
(case/'cpa-native-tui-result.json').write_text(json.dumps(results,indent=2));print(json.dumps(results))
