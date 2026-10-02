"""macOS only, two native Hermes history views; OS denies all network. No model prompt.
Usage: python hermes-offline-tui.py EXISTING_CASE
"""
import sys
import json,os,pty,signal,subprocess,time,select,fcntl,termios,struct,sqlite3,hashlib
from pathlib import Path
c=Path(sys.argv[1]).resolve();r=json.loads((c/'result.json').read_text());env=json.loads((c/'environment.json').read_text());plan=json.loads(next((c/'data/continuations').rglob('plan.json')).read_text());sid=r['operations'][0]['target_session_id']
env.update(OPENAI_BASE_URL='http://127.0.0.1:9/v1',HTTPS_PROXY='http://127.0.0.1:9',HTTP_PROXY='http://127.0.0.1:9',ALL_PROXY='http://127.0.0.1:9',TERM='xterm-256color')
results=[]
for i in range(2):
 master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',80,200,0,0))
 child=subprocess.Popen(['/usr/bin/sandbox-exec','-p','(version 1)(allow default)(deny network*)',plan['executable'],'--profile','default','--resume',sid],env=env,cwd=plan['workspace'],stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave)
 output=b'';declined=False;deadline=time.monotonic()+25
 try:
  while time.monotonic()<deadline and child.poll() is None:
   if select.select([master],[],[],0.2)[0]:
    try: chunk=os.read(master,65536)
    except OSError:break
    if not chunk:break
    output+=chunk
    if b'Set up a provider now? [Y/n]:' in output and not declined:
     os.write(master,b'n\n');declined=True
    if r['marker'].encode() in output and r['decision'].encode() in output:break
 finally:
  if child.poll() is None:
   os.killpg(child.pid,signal.SIGTERM)
   try:child.wait(timeout=3)
   except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
  os.close(master)
 (c/f'native-tui-offline-{i}.ansi').write_bytes(output)
 results.append({'run':i,'markerVisible':r['marker'].encode() in output,'decisionVisible':r['decision'].encode() in output,'declinedSetup':declined,'noModelPromptSent':True,'networkDeniedByOSSandbox':True,'pid':child.pid,'exitCodeAfterCleanup':child.returncode})
(c/'native-tui-offline-result.json').write_text(json.dumps(results,indent=2));print(json.dumps(results))
