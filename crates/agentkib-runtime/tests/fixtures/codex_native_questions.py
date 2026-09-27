#!/usr/bin/env python3
"""Isolated real Codex question round trip; local model, synthetic answers only."""
import json, pathlib, sys, tempfile, threading, time, uuid
from http.server import ThreadingHTTPServer
from codex_native_writer_lock import Peer, Model

class QuestionsModel(Model):
    requests = 0
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
        type(self).requests += 1
        if type(self).requests == 1:
            names = [t.get('name') for t in payload.get('tools', [])]
            assert 'request_user_input' in names, names
            item = {'id':'fc_question','type':'function_call','name':'request_user_input','call_id':'question_call','arguments':json.dumps({'questions':[{'id':'value','header':'Offline','question':'Synthetic input','isSecret':True,'isOther':True,'options':[{'label':'Synthetic','description':'Offline only'},{'label':'Skip','description':'No change'}]}]}),'status':'completed'}
        else:
            item = {'id':'msg_done','type':'message','role':'assistant','status':'completed','content':[{'type':'output_text','text':'offline-question-ok','annotations':[]}]}
        rid='resp_'+uuid.uuid4().hex
        events=[('response.created',{'response':{'id':rid,'object':'response','status':'in_progress','output':[]}}),('response.output_item.added',{'output_index':0,'item':{**item,'status':'in_progress'}}),('response.output_item.done',{'output_index':0,'item':item}),('response.completed',{'response':{'id':rid,'object':'response','status':'completed','output':[item],'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}})]
        data=''.join('event: '+event+'\ndata: '+json.dumps({'type':event,**body})+'\n\n' for event,body in events).encode()
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)

def main():
    for executable in sys.argv[1:]:
        with tempfile.TemporaryDirectory(prefix='agentkib-native-questions-') as tmp:
            root=pathlib.Path(tmp)
            for name in ['user','codex','workspace','tmp']:(root/name).mkdir()
            QuestionsModel.requests=0
            server=ThreadingHTTPServer(('127.0.0.1',0),QuestionsModel)
            threading.Thread(target=server.serve_forever,daemon=True).start()
            peer=Peer(executable,root,server.server_port)
            try:
                created=peer.call('thread/start',{'cwd':str(root/'workspace'),'approvalPolicy':'on-request','sandbox':'workspace-write'})
                native=created['result']['thread']['id']
                sent=peer.call('turn/start',{'threadId':native,'input':[{'type':'text','text':'Ask the offline synthetic question. No files or commands.'}],'collaborationMode':{'mode':'plan','settings':{'model':'offline-model','reasoning_effort':'low','developer_instructions':None}}})
                assert 'result' in sent,sent
                deadline=time.monotonic()+25
                request=None
                while time.monotonic()<deadline:
                    if peer.events: item=peer.events.pop(0)
                    else: item=peer.messages.get(timeout=max(.1,deadline-time.monotonic()))
                    if item.get('method')=='item/tool/requestUserInput':request=item;break
                    if item.get('method')=='turn/completed': raise AssertionError('turn completed without native question')
                assert request is not None,'native question missing'
                q=request['params']['questions'][0]
                assert q['isSecret'] is True,q
                peer.write({'id':request['id'],'result':{'answers':{'value':{'answers':['synthetic-value']}}}})
                done=peer.completed()
                assert done['params']['turn']['status']=='completed',done
                assert any(event.get('method')=='serverRequest/resolved' and event.get('params',{}).get('requestId')==request['id'] for event in peer.events),'native answer resolution missing'
                print(json.dumps({'binary':executable,'nativeSecretQuestion':True,'nativeCustomAnswer':True,'nativeAnswerResolved':True,'offlineModel':True}))
            finally:
                peer.close();server.shutdown()

if __name__=='__main__':main()
