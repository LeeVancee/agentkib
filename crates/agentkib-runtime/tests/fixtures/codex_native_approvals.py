#!/usr/bin/env python3
"""Synthetic approval grants on real isolated app-server, never real credentials."""
import json,pathlib,sys,tempfile,threading,time,uuid
from http.server import ThreadingHTTPServer
from codex_native_writer_lock import Peer,Model
class ApprovalModel(Model):
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
        self.server.requests+=1
        if self.server.requests==1:
            names=[t.get('name') for t in body.get('tools',[])]
            tool='request_permissions' if self.server.choice=='permissions' else 'exec_command'
            assert tool in names,names
            args={'cmd':'/usr/bin/true','sandbox_permissions':'require_escalated','justification':'Isolated native approval test'}
            if self.server.choice=='acceptWithExecpolicyAmendment':args['prefix_rule']=['/usr/bin/true']
            if self.server.choice=='permissions':args={'permissions':{'network':{'enabled':True}},'reason':'Offline native scope test'}
            item={'type':'function_call','id':'fc_approval','call_id':'call_approval','name':tool,'arguments':json.dumps(args)}
        else:item={'type':'message','id':'msg_done','role':'assistant','content':[{'type':'output_text','text':'done','annotations':[]}],'status':'completed'}
        rid='resp_'+uuid.uuid4().hex
        events=[('response.created',{'response':{'id':rid,'status':'in_progress','output':[]}}),('response.output_item.added',{'output_index':0,'item':item}),('response.output_item.done',{'output_index':0,'item':item}),('response.completed',{'response':{'id':rid,'status':'completed','output':[item],'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}})]
        data=''.join('event: '+kind+'\ndata: '+json.dumps({'type':kind,**v})+'\n\n' for kind,v in events).encode()
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
def main():
    for exe in sys.argv[1:]:
        for choice in ['accept','acceptWithExecpolicyAmendment','permissions']:
            with tempfile.TemporaryDirectory(prefix='agentkib-native-approval-') as tmp:
                root=pathlib.Path(tmp)
                for n in ['user','codex','workspace','tmp']:(root/n).mkdir()
                server=ThreadingHTTPServer(('127.0.0.1',0),ApprovalModel);server.requests=0;server.choice=choice
                threading.Thread(target=server.serve_forever,daemon=True).start()
                p=Peer(exe,root,server.server_port,{'features.shell_tool':True,'features.request_permissions_tool':True})
                try:
                    native=p.call('thread/start',{'cwd':str(root/'workspace'),'approvalPolicy':'on-request','approvalsReviewer':'user','sandbox':'workspace-write'})['result']['thread']['id']
                    p.call('turn/start',{'threadId':native,'input':[{'type':'text','text':'Use synthetic tool'}]})
                    end=time.monotonic()+20;request=None
                    while time.monotonic()<end:
                        item=p.events.pop(0) if p.events else p.messages.get(timeout=max(.1,end-time.monotonic()))
                        if item.get('method') in ['item/commandExecution/requestApproval','item/permissions/requestApproval']:request=item;break
                        assert item.get('method')!='turn/completed','no native approval'
                    assert request is not None
                    assert pathlib.Path(request['params']['cwd']).is_absolute()
                    options=request['params'].get('availableDecisions') or []
                    if choice=='permissions':decision={'permissions':request['params']['permissions'],'scope':'session'}
                    elif choice=='accept':decision=choice
                    else:decision=next((o for o in options if isinstance(o,dict) and choice in o),None)
                    assert choice=='permissions' or decision in options,{'requestedChoice':choice,'offered':options}
                    p.write({'id':request['id'],'result':decision if choice=='permissions' else {'decision':decision}})
                    done=p.completed();assert done['params']['turn']['status']=='completed',done['params']['turn'].get('error')
                    assert any(e.get('method')=='serverRequest/resolved' and e['params']['requestId']==request['id'] for e in p.events),'no resolved event'
                    print(json.dumps({'binary':exe,'nativeApproval':choice,'resolved':True,'offlineModel':True}))
                finally:p.close();server.shutdown()
if __name__=='__main__':main()
