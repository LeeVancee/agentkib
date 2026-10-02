// Pure injected-fetch test: no HTTP server or external request is used.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {makeGuard, CPA_ENDPOINT, CPA_MODEL} from "./opencode-cpa-once-guard.mjs";
const root = path.resolve(process.argv[2]);
if (fs.existsSync(root)) throw Error("New test directory required");
fs.mkdirSync(root, {mode: 0o700, recursive: true});
let calls = 0;
const nativeFetch = async () => {calls++; return new Response("mock", {status: 200});};
const policy = {requestRetry: 0, maxRetryCredentials: 1, streamBootstrapRetries: 0,
  credentialOverrides: false, ccSwitchRectifierEnabled: false, ccSwitchAutoFailoverEnabled: false};
const history = [{role:"user",text:"marker M"},{role:"assistant",text:"decision D"}];
const prompt = "Recall.";
function setup(name, patch = {}) {
 const dir=path.join(root,name);fs.mkdirSync(dir,{mode:0o700});
 const proof=path.join(dir,"window.json");
 fs.writeFileSync(proof,JSON.stringify({schemaVersion:1,status:"open",endpoint:"http://127.0.0.1:8317",model:CPA_MODEL,
 expiresAt:new Date(Date.now()+60000).toISOString(),retryPolicy:policy,...patch}));
 const file=path.join(dir,"contract.json");
 fs.writeFileSync(file,JSON.stringify({endpoint:CPA_ENDPOINT,model:CPA_MODEL,sessionId:"ses_mock",history,prompt,retryWindow:proof}));
 return {file,proof};
}
for (const [name, patch] of [["closed",{status:"closed"}],["expired",{expiresAt:"2020-01-01T00:00:00Z"}],
 ["wrong-model",{model:"other"}],["retry-enabled",{retryPolicy:{...policy,requestRetry:1}}]]) {
 const {file}=setup(name,patch); assert.throws(()=>makeGuard(file,{nativeFetch}));
}
const active=setup("active");const guard=makeGuard(active.file,{nativeFetch});
const request = {method:"POST",headers:{"content-type":"application/json","x-session-id":"ses_mock","x-session-affinity":"ses_mock"},
 body:JSON.stringify({model:CPA_MODEL,stream:true,messages:[...history.map(x=>({role:x.role,content:x.text})),{role:"user",content:prompt}]})};
fs.writeFileSync(active.proof,JSON.stringify({status:"closed"}));
await assert.rejects(guard(CPA_ENDPOINT,request));assert.equal(calls,0);
assert.equal(fs.existsSync(path.join(path.dirname(active.file),"dispatch-token.json")),false);
const positive=setup("positive");await makeGuard(positive.file,{nativeFetch})(CPA_ENDPOINT,request);assert.equal(calls,1);
const result={passed:true,negativeCases:5,injectedFetchCalls:1,realNetworkCalls:0};
fs.writeFileSync(path.join(root,"result.json"),JSON.stringify(result));console.log(JSON.stringify(result));
