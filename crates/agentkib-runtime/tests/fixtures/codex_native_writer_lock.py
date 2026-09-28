#!/usr/bin/env python3
"""Explicit, offline acceptance: two real Codex binaries, isolated homes, local fake model.
No credentials inherited; never points at an existing Codex home or thread.
Usage: python3 codex_native_writer_lock.py /path/to/codex [/path/to/other/codex]
"""
import json, os, pathlib, queue, subprocess, sys, tempfile, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Model(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length',0)))
        rid='resp_'+uuid.uuid4().hex
        item={'id':'msg_'+uuid.uuid4().hex,'type':'message','role':'assistant','status':'completed','content':[{'type':'output_text','text':'offline-ok','annotations':[]}]}
        events=[('response.created',{'response':{'id':rid,'object':'response','status':'in_progress','output':[]}}),('response.output_item.added',{'output_index':0,'item':{**item,'status':'in_progress','content':[]}}),('response.output_text.delta',{'item_id':item['id'],'output_index':0,'content_index':0,'delta':'offline-ok'}),('response.output_item.done',{'output_index':0,'item':item}),('response.completed',{'response':{'id':rid,'object':'response','status':'completed','output':[item],'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}})]
        data=''.join('event: '+event+'\ndata: '+json.dumps({'type':event,**payload})+'\n\n' for event,payload in events).encode()
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def do_GET(self):
        data=json.dumps({'data':[]}).encode();self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)

class Peer:
    def __init__(self,exe,root,port,config_overrides=None):
        self.messages=queue.Queue();self.events=[];self.seq=0
        config={'model_provider':'offline_test','model':'offline-model','model_providers.offline_test.name':'Offline test','model_providers.offline_test.base_url':f'http://127.0.0.1:{port}/v1','model_providers.offline_test.wire_api':'responses','model_providers.offline_test.requires_openai_auth':False,'features.shell_tool':False}
        config.update(config_overrides or {})
        args=[exe,'app-server','--stdio']
        for key,value in config.items():args+=['-c',key+'='+json.dumps(value)]
        env={'HOME':str(root/'user'),'CODEX_HOME':str(root/'codex'),'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','TMPDIR':str(root/'tmp')}
        self.proc=subprocess.Popen(args,env=env,cwd=root/'workspace',stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,start_new_session=True)
        def read():
            for line in self.proc.stdout:
                try:self.messages.put(json.loads(line))
                except ValueError:pass
            self.messages.put(None)
        threading.Thread(target=read,daemon=True).start()
        self.call('initialize',{'clientInfo':{'name':'agentkib-offline-lock-test','version':'1'},'capabilities':{'experimentalApi':True}});self.write({'method':'initialized','params':{}})
    def write(self,value):self.proc.stdin.write(json.dumps(value)+'\n');self.proc.stdin.flush()
    def call(self,method,params):
        self.seq+=1;request=self.seq;self.write({'id':request,'method':method,'params':params});until=time.monotonic()+30
        while time.monotonic()<until:
            item=self.messages.get(timeout=max(.1,until-time.monotonic()))
            if item is None:raise RuntimeError('app-server exited during '+method)
            if item.get('id')==request:return item
            self.events.append(item)
        raise RuntimeError('timed out: '+method)
    def completed(self):
        until=time.monotonic()+30
        while time.monotonic()<until:
            for i,item in enumerate(self.events):
                if item.get('method')=='turn/completed':return self.events.pop(i)
            item=self.messages.get(timeout=max(.1,until-time.monotonic()))
            if item is None:raise RuntimeError('app-server exited')
            self.events.append(item)
        raise RuntimeError('turn did not complete')
    def close(self):
        if self.proc.poll() is None:
            self.proc.stdin.close()
            try:self.proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid,15);self.proc.wait(timeout=5)

def main():
    binaries=sys.argv[1:];assert binaries,'Pass a Codex executable explicitly'
    first=binaries[0];second=binaries[-1]
    with tempfile.TemporaryDirectory(prefix='agentkib-codex-native-lock-') as tmp:
        root=pathlib.Path(tmp)
        for name in ['user','codex','workspace','tmp']:(root/name).mkdir()
        server=ThreadingHTTPServer(('127.0.0.1',0),Model);threading.Thread(target=server.serve_forever,daemon=True).start();peers=[]
        try:
            a=Peer(first,root,server.server_port);peers.append(a)
            params={'cwd':str(root/'workspace'),'approvalPolicy':'on-request','approvalsReviewer':'user','sandbox':'workspace-write','config':{'sandbox_workspace_write.network_access':False,'sandbox_workspace_write.writable_roots':[]}}
            created=a.call('thread/start',params);assert 'result' in created,created
            policy=created['result']
            assert policy['approvalPolicy']=='on-request' and policy['approvalsReviewer']=='user',policy
            assert policy['sandbox']['type']=='workspaceWrite' and policy['sandbox']['networkAccess']==False,policy
            assert all(pathlib.Path(p).resolve()==(root/'workspace').resolve() for p in policy['sandbox']['writableRoots']),policy
            native=policy['thread']['id']
            message_id=str(uuid.uuid4())
            sent=a.call('turn/start',{'threadId':native,'clientUserMessageId':message_id,'input':[{'type':'text','text':'Reply offline-ok. Do not run any tools.'}]});assert 'result' in sent,sent
            completed=a.completed();assert completed['params']['turn']['status']=='completed',completed
            b=Peer(second,root,server.server_port);peers.append(b)
            metadata=b.call('thread/read',{'threadId':native,'includeTurns':False})
            assert metadata.get('result',{}).get('thread',{}).get('id')==native,metadata
            assert pathlib.Path(metadata['result']['thread']['cwd']).resolve()==(root/'workspace').resolve(),metadata
            assert metadata['result']['thread'].get('turns',[])==[],metadata
            denied=b.call('thread/resume',{'threadId':native});assert 'error' in denied,denied
            assert 'writer' in denied['error']['message'].lower(),denied
            a.close()
            resumed=b.call('thread/resume',{'threadId':native});assert resumed.get('result',{}).get('thread',{}).get('id')==native,resumed
            history=resumed['result']['thread'].get('turns',[])
            assert any(i.get('type')=='agentMessage' and i.get('text')=='offline-ok' for t in history for i in t.get('items',[])),history
            assert any(i.get('type')=='userMessage' and i.get('clientId')==message_id for t in history for i in t.get('items',[])),history
            print(json.dumps({'nativeFixedPolicy':True,'nativeMetadataReadWithoutOwnership':True,'nativeUserMessageIdPreserved':True,'nativeWriterConflict':True,'sameIdResumeAfterRelease':True,'historyPreserved':True,'mockOnly':True}))
        finally:
            for peer in peers:peer.close()
            server.shutdown()
if __name__=='__main__':main()
