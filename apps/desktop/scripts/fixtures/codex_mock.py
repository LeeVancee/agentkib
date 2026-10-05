#!/usr/bin/python3
import json,sys,os,pathlib,uuid,fcntl,time,threading
if '--version' in sys.argv:
 print('codex-cli 0.155.1');sys.exit()
home=pathlib.Path(os.environ['CODEX_HOME']);native=None;turn=None;history=[];lock=None;queued=[];name=None;goal=None;settings=None

def emit(value):print(json.dumps(value),flush=True)
def event(method,params):emit({'method':method,'params':params})
def save():
 if native:(home/(native+'.json')).write_text(json.dumps(history))
def complete():
 global turn
 is_plan=(settings or {}).get('collaborationMode',{}).get('mode')=='plan';text='# Native plan\nInspect, then implement.' if is_plan else 'reply'
 if is_plan:event('item/plan/delta',{'threadId':native,'turnId':turn,'itemId':'item-'+turn,'delta':text})
 else:event('item/agentMessage/delta',{'threadId':native,'turnId':turn,'itemId':'item-'+turn,'delta':text})
 item={'type':'plan' if is_plan else 'agentMessage','id':'item-'+turn,'text':text};history[-1]['items'].append(item);event('item/completed',{'threadId':native,'turnId':turn,'item':item});history[-1]['status']='completed';save();event('turn/completed',{'threadId':native,'turn':history[-1]});turn=None
 event('thread/tokenUsage/updated',{'threadId':native,'turnId':history[-1]['id'],'tokenUsage':{'total':{'inputTokens':8,'cachedInputTokens':0,'outputTokens':4,'reasoningOutputTokens':1,'totalTokens':13},'last':{'inputTokens':8,'cachedInputTokens':0,'outputTokens':4,'reasoningOutputTokens':1,'totalTokens':13},'modelContextWindow':258000}})

def thread():return {'id':native,'cwd':os.getcwd(),'turns':history,'status':{'type':'idle' if turn is None else 'active'},'name':name}
def benchmark_stream():
 # Synthetic, opt-in fixture: timestamps originate in the native subprocess,
 # immediately before stdout, not in the host/renderer receiving the event.
 global turn
 time.sleep(0.1)
 text=''
 for index in range(40):
  delta='[stream-benchmark:%d:%.3f] ' % (index, time.time_ns()/1_000_000)
  text+=delta
  event('item/agentMessage/delta',{'threadId':native,'turnId':turn,'itemId':'benchmark-item','delta':delta})
  time.sleep(0.08)
 item={'type':'agentMessage','id':'benchmark-item','text':text}
 history[-1]['items'].append(item);history[-1]['status']='completed';save()
 event('item/completed',{'threadId':native,'turnId':turn,'item':item})
 event('turn/completed',{'threadId':native,'turn':history[-1]});turn=None
for line in sys.stdin:
 r=json.loads(line);method=r.get('method');p=r.get('params',{});req=r.get('id')
 if not method:
  event('serverRequest/resolved',{'threadId':native,'requestId':req});complete();continue
 if method=='initialized':continue
 if method=='initialize':result={}
 elif method=='model/list':result={'data':[{'id':'mock-model','model':'mock-model','displayName':'Mock','isDefault':True,'defaultReasoningEffort':'medium','defaultServiceTier':None,'serviceTiers':[{'id':'fast','name':'Fast','description':'Fast'}],'supportedReasoningEfforts':[{'reasoningEffort':'medium'}]}]}
 elif method=='collaborationMode/list':
  if (home/'disable-modes').exists():emit({'id':req,'error':{'code':-32601,'message':'unsupported'}});continue
  result={'data':[{'mode':'plan','name':'Plan'},{'mode':'default','name':'Default'}]}
 elif method=='skills/list':
  skill=pathlib.Path(os.getcwd())/'skill'/'SKILL.md';skills=([{'name':'fixture-skill','description':'Fixture skill','path':str(skill),'scope':'repo','enabled':True,'pluginId':None}] if skill.exists() else []);result={'data':[{'cwd':os.getcwd(),'errors':[],'skills':skills}]}
 elif method=='thread/goal/get':
  result={'goal':dict(goal) if goal else None}
  if goal and (home/'goal-read-event').exists():goal['status']='blocked';event('thread/goal/updated',{'threadId':native,'goal':goal})
 elif method in ['thread/start','thread/resume','thread/fork']:
  native=(str(uuid.uuid4()) if method=='thread/fork' else p.get('threadId',str(uuid.uuid4())));lock=open(home/(native+'.lock'),'w')
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:emit({'id':req,'error':{'code':-32603,'message':'already has an active writer'}});continue
  path=home/(native+'.json');history=json.loads(path.read_text()) if path.exists() else [];save();event('thread/started',{'thread':thread()});sandbox=({'type':'dangerFullAccess'} if p.get('sandbox')=='danger-full-access' else {'type':'workspaceWrite','writableRoots':[os.getcwd()],'networkAccess':False});result={'thread':thread(),'model':p.get('model','mock-model'),'reasoningEffort':p.get('config',{}).get('model_reasoning_effort','medium'),'serviceTier':p.get('serviceTier'),'cwd':os.getcwd(),'approvalPolicy':p.get('approvalPolicy','on-request'),'approvalsReviewer':p.get('approvalsReviewer','user'),'sandbox':sandbox}
 elif method=='thread/read':
  with open(home/'read-calls.jsonl','a') as calls:calls.write(json.dumps(p)+'\n')
  native=p['threadId'];path=home/(native+'.json');history=json.loads(path.read_text()) if path.exists() else []
  result={'thread':{**thread(),'turns':history if p.get('includeTurns') else [],'projectId':'mock-project','gitInfo':{'branch':'mock-branch'}}}
 elif method=='turn/start':
  settings={'model':p.get('model','mock-model'),'effort':p.get('effort','medium'),'serviceTier':p.get('serviceTier'),'collaborationMode':p.get('collaborationMode',{'mode':'default','settings':{'model':p.get('model','mock-model'),'reasoning_effort':p.get('effort','medium'),'developer_instructions':None}}),'approvalPolicy':p.get('approvalPolicy','on-request'),'approvalsReviewer':p.get('approvalsReviewer','user'),'sandboxPolicy':p.get('sandboxPolicy',{'type':'workspaceWrite','writableRoots':[os.getcwd()],'networkAccess':False}),'cwd':os.getcwd(),'modelProvider':'mock'}
  if not (home/'suppress-settings-event').exists():event('thread/settings/updated',{'threadId':native,'threadSettings':settings})
  with open(home/'turn-calls.jsonl','a') as calls:calls.write(json.dumps(p)+'\n')
  text=p['input'][0]['text'];turn=str(uuid.uuid4());user={'type':'userMessage','id':str(uuid.uuid4()),'clientId':p['clientUserMessageId'],'content':p['input']};history.append({'id':turn,'status':'inProgress','items':[user]});save();event('turn/started',{'threadId':native,'turn':history[-1]});event('item/completed',{'threadId':native,'turnId':turn,'item':user});result={'turn':{'id':turn,'status':'inProgress'}}
  if text=='approval':emit({'method':'item/commandExecution/requestApproval','id':90,'params':{'threadId':native,'turnId':turn,'itemId':'cmd','command':'/usr/bin/true','cwd':os.getcwd()}})
  elif text=='question':emit({'method':'item/tool/requestUserInput','id':91,'params':{'threadId':native,'turnId':turn,'questions':[{'id':'choice','question':'Which?','options':[{'label':'A'}],'isOther':False}]}})
  elif text=='stream-benchmark' and (home/'allow-stream-benchmark').exists():threading.Thread(target=benchmark_stream,daemon=True).start()
  elif text!='hold':complete()
  if text=='lost-receipt':sys.exit()
 elif method=='turn/steer':
  assert p['expectedTurnId']==turn
  user={'type':'userMessage','id':str(uuid.uuid4()),'clientId':p['clientUserMessageId'],'content':p['input']};history[-1]['items'].append(user);save();result={'turnId':turn}
 elif method=='thread/name/set':name=p['name'];result={}
 elif method=='thread/goal/set':
  with open(home/'goal-calls.jsonl','a') as calls:calls.write(json.dumps(p)+'\n')
  old=goal or {};objective=p.get('objective') if p.get('objective') is not None else old.get('objective','goal');goal={'threadId':native,'objective':objective,'status':p.get('status') or old.get('status','active'),'tokenBudget':p.get('tokenBudget',old.get('tokenBudget')),'tokensUsed':old.get('tokensUsed',0),'timeUsedSeconds':old.get('timeUsedSeconds',0),'createdAt':1,'updatedAt':1};event('thread/goal/updated',{'threadId':native,'goal':goal});result={'goal':dict(goal)}
  if (home/'goal-fast-event').exists() and goal['status']=='active':goal['status']='budgetLimited';goal['tokensUsed']=2;event('thread/goal/updated',{'threadId':native,'goal':goal})
 elif method=='thread/goal/clear':goal=None;event('thread/goal/cleared',{'threadId':native});result={}
 elif method=='thread/archive':result={}
 elif method=='thread/unarchive':result={'thread':thread()}
 elif method=='thread/queue/list':result={'data':queued,'nextCursor':None}
 elif method=='thread/queue/add':
  row={'id':str(uuid.uuid4()),'input':p['input'],'clientUserMessageId':p['clientUserMessageId']};queued.append(row);result={'queuedSubmission':row}
 elif method=='thread/queue/update':
  row=next(q for q in queued if q['id']==p['queuedSubmissionId']);row['input']=p['input'];result={'queuedSubmission':row}
 elif method=='thread/queue/delete':queued=[q for q in queued if q['id']!=p['queuedSubmissionId']];result={}
 elif method=='thread/queue/reorder':queued=sorted(queued,key=lambda q:p['queuedSubmissionIds'].index(q['id']));result={}
 elif method=='turn/interrupt':
  assert p['turnId']==turn;complete();result={}
 else:emit({'id':req,'error':{'code':-32601,'message':'unsupported'}});continue
 emit({'id':req,'result':result})
 if method in ['thread/resume','thread/read'] and (home/'hydrate-response-live').exists():
  (home/'hydrate-response-live').unlink();turn='after-hydration';history.append({'id':turn,'status':'inProgress','items':[]})
  event('turn/started',{'threadId':native,'turn':history[-1]})
  event('item/agentMessage/delta',{'threadId':native,'turnId':turn,'itemId':'after-hydration-item','delta':'live after response'})
  save()
