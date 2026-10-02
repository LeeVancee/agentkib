'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {dispatch,hash,safe,saveBinding,loadBinding,retryLoop} = require('./extension.cjs')._test;
function fixture() {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'akib-bridge-test-')));
  const calls=[];
  const context={globalStorageUri:{fsPath:path.join(root,'agentkib.cursor-bridge')}};
  const vscode={workspace:{workspaceFolders:[{uri:{scheme:'file',fsPath:root}}]},env:{sessionId:'window'},commands:{executeCommand:async(name,...args)=>{calls.push([name,...args]);if(name==='composer.getOrderedSelectedComposerIds')return [] ;return {successCount:1,failureCount:0};}}};
  const binding={boot_id:randomUUID(),binding_id:randomUUID(),lease:randomUUID()};
  const payload=JSON.stringify({version:1,conversationState:'AA==',blobs:{},name:'fixture'});
  const message={protocol:1,...binding,request_id:randomUUID(),workspace:root,action:'import',args:{operation_id:randomUUID(),plan_hash:hash('plan'),payload,payload_hash:hash(payload)}};
  return {root,calls,context,vscode,binding,message,close:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('import consumes durably before importer and duplicate requests do not import twice', async()=>{
 const f=fixture();try {await dispatch(f.context,f.vscode,f.message,f.binding);await dispatch(f.context,f.vscode,f.message,f.binding);assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'developer.bulkImportChats');const dir=f.calls[0][1];assert.deepEqual(fs.readdirSync(dir),['import.json']);assert.equal(fs.readFileSync(path.join(dir,'import.json'),'utf8'),f.message.args.payload);}finally{f.close();}
});
test('lost import response stays consumed and does not rerun',async()=>{
 const f=fixture();try{f.vscode.commands.executeCommand=async()=>{f.calls.push('import');throw Error('Lost response');};await assert.rejects(dispatch(f.context,f.vscode,f.message,f.binding));assert.deepEqual(await dispatch(f.context,f.vscode,f.message,f.binding),{consumed:true});assert.equal(f.calls.length,1);}finally{f.close();}
});
test('mismatched fingerprint, lease, workspace and arbitrary action fail before commands',async()=>{
 for(const mutate of [m=>m.args.payload_hash=hash('different'),m=>m.lease=randomUUID(),m=>m.workspace='/outside',m=>m.action='arbitrary.execute']){const f=fixture();try{mutate(f.message);await assert.rejects(dispatch(f.context,f.vscode,f.message,f.binding));assert.equal(f.calls.length,0);}finally{f.close();}}
});
test('same operation with changed approved plan is rejected',async()=>{const f=fixture();try{await dispatch(f.context,f.vscode,f.message,f.binding);f.message.args.plan_hash=hash('different');await assert.rejects(dispatch(f.context,f.vscode,f.message,f.binding));assert.equal(f.calls.length,1);}finally{f.close();}});
test('open verifies the exact native ID selected, without importing',async()=>{const f=fixture();try{f.message.action='open';f.message.args={native_id:randomUUID()};await assert.rejects(dispatch(f.context,f.vscode,f.message,f.binding));assert.deepEqual(f.calls.map(c=>c[0]),['composer.openComposer','composer.getOrderedSelectedComposerIds']);}finally{f.close();}});
test('linked operation directory fails before importer',async()=>{const f=fixture();try{const dir=path.join(f.context.globalStorageUri.fsPath,'operations-v1');fs.mkdirSync(dir,{recursive:true});fs.symlinkSync(f.root,path.join(dir,f.message.args.operation_id),process.platform==='win32'?'junction':'dir');await assert.rejects(dispatch(f.context,f.vscode,f.message,f.binding));assert.equal(f.calls.length,0);}finally{f.close();}});
test('path traversal is not accepted',()=>{assert.throws(()=>safe('/tmp/../private'));});
test('parallel extension hosts retain each credential without a shared read-modify-write',async()=>{
 const values=new Map(),key='workspace';
 const secrets={get:async k=>values.get(k),store:async(k,v)=>{await Promise.resolve();values.set(k,v);}};
 const a={binding_id:randomUUID(),credential:'a'},b={binding_id:randomUUID(),credential:'b'};
 await Promise.all([saveBinding(secrets,key,a),saveBinding(secrets,key,b)]);
 assert.deepEqual(JSON.parse(values.get(key+'.'+a.binding_id)),a);
 assert.deepEqual(JSON.parse(values.get(key+'.'+b.binding_id)),b);
 const hint=JSON.parse(values.get(key)).binding_id;
 assert.deepEqual(await loadBinding(secrets,key),hint===a.binding_id?a:b);
 assert.equal((await loadBinding(secrets,key)).bindings,undefined);
});
test('discovery hint never accepts a mismatched binding credential',async()=>{
 const id=randomUUID();const values=new Map([['key',JSON.stringify({binding_id:id})],['key.'+id,JSON.stringify({binding_id:randomUUID(),credential:'other'})]]);
 assert.equal(await loadBinding({get:async k=>values.get(k)},'key'),undefined);
});
test('late Runtime availability retains bounded reconnection and dispose cancels it',async()=>{
 let available=false,active=false,attempts=0;const scheduled=new Map();let seq=0;const waits=[];
 const loop=retryLoop(async()=>{attempts++;if(!available)throw Error('Socket not created');active=true;return true;},()=>active,(fn,ms)=>{waits.push(ms);scheduled.set(++seq,fn);return seq;},id=>scheduled.delete(id));
 await loop.wake();assert.equal(attempts,1);assert.deepEqual(waits,[2000]);
 for(let i=0;i<7;i++){const [id,fn]=scheduled.entries().next().value;scheduled.delete(id);fn();await Promise.resolve();await Promise.resolve();}
 assert.equal(Math.max(...waits),30000);assert.equal(scheduled.size,1);
 available=true;const [id,fn]=scheduled.entries().next().value;scheduled.delete(id);fn();await Promise.resolve();await Promise.resolve();
 assert.equal(active,true);assert.equal(scheduled.size,0);
 active=false;loop.reset();loop.schedule();assert.equal(waits.at(-1),2000);assert.equal(scheduled.size,1);
 loop.dispose();assert.equal(scheduled.size,0);await loop.wake();assert.equal(attempts,9);
});
test('unpaired extension does not poll or replay an import to reconnect',async()=>{
 let scheduled=0,attempts=0;const loop=retryLoop(async()=>{attempts++;return false;},()=>false,()=>{scheduled++;return 1;},()=>{});
 await loop.wake();assert.equal(attempts,1);assert.equal(scheduled,0);loop.dispose();
});
