#!/usr/bin/env python3
"""Real app-server completion contract test with isolated home and offline model."""
import json, pathlib, sys, tempfile, threading, uuid, time, io, zlib, struct
from http.server import ThreadingHTTPServer
from codex_native_writer_lock import Peer, Model

class SlowModel(Model):
    def do_POST(self):
        body=self.rfile.read(int(self.headers.get('Content-Length',0)))
        self.server.requests.append(json.loads(body))
        original=self.rfile;self.rfile=io.BytesIO(body)
        try:
            time.sleep(3)
            super().do_POST()
        finally:self.rfile=original

def main():
    for exe in sys.argv[1:]:
        with tempfile.TemporaryDirectory(prefix='agentkib-completion-native-') as tmp:
            root=pathlib.Path(tmp)
            for n in ['user','codex','workspace','tmp']:(root/n).mkdir()
            server=ThreadingHTTPServer(('127.0.0.1',0),SlowModel)
            server.requests=[]
            threading.Thread(target=server.serve_forever,daemon=True).start()
            p=Peer(exe,root,server.server_port)
            def call(method,**args):
                r=p.call(method,args)
                assert 'result' in r,(method,r)
                return r['result']
            try:
                native=call('thread/start',cwd=str(root/'workspace'),approvalPolicy='on-request',sandbox='workspace-write',model='gpt-5.5')['thread']['id']
                sent=call('turn/start',threadId=native,clientUserMessageId=str(uuid.uuid4()),input=[{'type':'text','text':'Initial offline'}])
                steer_id=str(uuid.uuid4())
                call('turn/steer',threadId=native,expectedTurnId=sent['turn']['id'],clientUserMessageId=steer_id,input=[{'type':'text','text':'Steered offline'}])
                p.completed()
                history=call('thread/read',threadId=native,includeTurns=True)['thread']
                assert any(i.get('clientId')==steer_id for t in history['turns'] for i in t['items']), history
                stale=p.call('turn/steer',{'threadId':native,'expectedTurnId':sent['turn']['id'],'input':[{'type':'text','text':'Must fail'}]})
                assert 'error' in stale
                call('thread/name/set',threadId=native,name='Offline renamed')
                assert call('thread/read',threadId=native,includeTurns=False)['thread']['name']=='Offline renamed'
                call('turn/start',threadId=native,input=[{'type':'text','text':'Hold queue editing turn'}])
                q1=str(uuid.uuid4());q2=str(uuid.uuid4())
                a=call('thread/queue/add',threadId=native,clientUserMessageId=q1,input=[{'type':'text','text':'Queued one'}])['queuedSubmission']
                b=call('thread/queue/add',threadId=native,clientUserMessageId=q2,input=[{'type':'text','text':'Queued two'}])['queuedSubmission']
                assert a['clientUserMessageId']==q1
                observer=Peer(exe,root,server.server_port)
                try:
                    queued_read=observer.call('thread/queue/list',{'threadId':native})
                    assert any(q.get('clientUserMessageId')==q1 for q in queued_read['result']['data']),queued_read
                finally:observer.close()
                aid=a['id'];bid=b['id']
                call('thread/queue/update',threadId=native,queuedSubmissionId=aid,input=[{'type':'text','text':'Updated queue'}])
                call('thread/queue/reorder',threadId=native,queuedSubmissionIds=[bid,aid])
                entries=call('thread/queue/list',threadId=native)['data']; assert entries[0]['id']==bid,entries
                call('thread/queue/delete',threadId=native,queuedSubmissionId=bid)
                p.completed();p.completed()
                assert call('thread/queue/list',threadId=native)['data']==[]
                history=call('thread/read',threadId=native,includeTurns=True)['thread']
                assert any(i.get('clientId')==q1 for t in history['turns'] for i in t['items']),history
                settings=call('thread/settings/update',threadId=native,model='gpt-5.5',effort='low',collaborationMode={'mode':'plan','settings':{'model':'gpt-5.5','reasoning_effort':'low','developer_instructions':None}})
                assert settings=={}
                image=root/'workspace'/'pixel.png'
                def chunk(kind,data):return struct.pack('!I',len(data))+kind+data+struct.pack('!I',zlib.crc32(kind+data)&0xffffffff)
                image.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',8,8,8,2,0,0,0))+chunk(b'IDAT',zlib.compress((b'\x00'+b'\xff\x00\x00'*8)*8))+chunk(b'IEND',b''))
                file=root/'workspace'/'note.txt';file.write_text('offline fixture')
                call('turn/start',threadId=native,input=[{'type':'text','text':'Read the attached file: '+str(file)},{'type':'localImage','path':str(image)}]);p.completed()
                assert server.requests[-1]['model']=='gpt-5.5'
                assert any('input_image' in json.dumps(x) for x in server.requests[-1].get('input',[])), 'local image did not reach model'
                assert any(t.get('name')=='request_user_input' for t in server.requests[-1].get('tools',[])), 'next-turn plan mode not active'
                assert server.requests[-1].get('reasoning',{}).get('effort')=='low', server.requests[-1].get('reasoning')
                history=call('thread/read',threadId=native,includeTurns=True)['thread']
                fork=call('thread/fork',threadId=native,lastTurnId=history['turns'][-1]['id'],deferGoalContinuation=True)['thread']
                assert fork['id']!=native
                call('thread/archive',threadId=fork['id'])
                call('thread/unarchive',threadId=fork['id'])
                revived=p.call('turn/start',{'threadId':fork['id'],'input':[{'type':'text','text':'After unarchive'}]})
                assert 'error' in revived
                call('thread/resume',threadId=fork['id'])
                call('turn/start',threadId=fork['id'],input=[{'type':'text','text':'After explicit resume'}]);p.completed()
                print(json.dumps({'binary':exe,'steerIdentity':True,'staleSteerRejected':True,'queueCrudConsumptionIdentity':True,'renameReadback':True,'settings':True,'forkArchiveExplicitResume':True,'localImageInput':True,'nextTurnEffort':True,'offlineModel':True}))
            finally:
                p.close();server.shutdown()
if __name__=='__main__':main()
