"""One explicitly authorized official OpenCode reply in an EXISTING QA session.

Usage: python opencode-native-once-live.py EXISTING_CASE RUNTIME
Never run as a preparation check: this sends one real prompt if admitted.
The fixed per-case attempt directory and durable token must never be reset.
"""
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time
from opencode_once_validation import validate_plan, validate_export

case, runtime = map(lambda p: Path(p).resolve(), sys.argv[1:])
attempt = case / "official-big-pickle-once-2026-09-30"
if attempt.exists():
    raise SystemExit("Prior attempt exists; inspect evidence instead of retrying")
prior = json.loads((case / "result.json").read_text())
if prior["target"] != "opencode" or prior["first"]["status"] != "launched":
    raise SystemExit("Existing verified native OpenCode session required")
operation, = prior["operations"]
session = operation["target_session_id"]
plan_file, = (case / "data/continuations").rglob("plan.json")
plan = validate_plan(prior, plan_file.read_bytes(), json.loads(plan_file.with_name("receipt.json").read_text()))
cli = plan["executable"]
workspace = Path(plan["workspace"])
env = json.loads((case / "environment.json").read_text())
attempt.mkdir(mode=0o700)
source = Path(prior["source"])
assert hashlib.sha256(source.read_bytes()).hexdigest() == prior["sourceSha256"]
config = Path(env["XDG_CONFIG_HOME"]) / "opencode/opencode.json"
original_config = config.read_bytes()
(attempt / "original-config.json").write_bytes(original_config)
result = {"model": "opencode/big-pickle", "sessionId": session,
          "runtimeSha256": hashlib.sha256(runtime.read_bytes()).hexdigest(), "automaticRetriesPermitted": False}


def native(*args):
    reply = subprocess.run([cli, *args], env=env, cwd=workspace, capture_output=True, check=True, timeout=30)
    return json.loads(reply.stdout)



before = native("export", session)
(attempt / "before-export.json").write_text(json.dumps(before, indent=2))
sessions = native("session", "list", "--format", "json")
assert len(sessions) == 1 and sessions[0]["id"] == session
history = validate_export(plan, before)
prompt = "Recall the exact random marker and the complete project storage decision from our previous conversation. Reply with those two values only. Do not read files or use tools. The answers are intentionally absent from this message."
assert prior["marker"] not in prompt and prior["decision"] not in prompt
contract = attempt / "contract.json"
contract.write_text(json.dumps({"endpoint": "https://opencode.ai/zen/v1/chat/completions", "model": "big-pickle",
    "sessionId": session, "history": history, "prompt": prompt}, indent=2))
isolated_config = {"$schema": "https://opencode.ai/config.json", "model": "opencode/big-pickle", "small_model": "opencode/big-pickle",
    "enabled_providers": ["opencode"], "autoupdate": False, "share": "disabled", "permission": "deny",
    "plugin": [str(Path(__file__).with_name("opencode-once-plugin.mjs"))],
    "provider": {"opencode": {"options": {"baseURL": "http://127.0.0.1:9/blocked"}}},
    "agent": {"title": {"disable": True}, "compaction": {"disable": True}, "build": {"tools": {"*": False}}},
    "compaction": {"auto": False, "prune": False}}
modified = json.dumps(isolated_config).encode()
live_env = dict(env, AGENTKIB_QA_ONCE_CONTRACT=str(contract), OPENCODE_EXPERIMENTAL_NATIVE_LLM="false")
live_env.pop("AGENTKIB_QA_ONCE_OFFLINE", None)
config.write_bytes(modified)
child = None
try:
    child = subprocess.Popen([cli, "run", "--session", session, "--model", "opencode/big-pickle", "--format", "json"],
        env=live_env, cwd=workspace, stdin=subprocess.PIPE, stdout=(attempt / "run.stdout").open("w"),
        stderr=(attempt / "run.stderr").open("w"), start_new_session=True)
    child.stdin.write(prompt.encode()); child.stdin.close()
    deadline = time.monotonic() + 150
    while child.poll() is None and time.monotonic() < deadline:
        log = attempt / "guard-events.jsonl"
        events = [json.loads(row) for row in log.read_text().splitlines()] if log.exists() else []
        if any(event["event"] == "blocked" for event in events):
            result["stoppedAfterBlockedExtraAttempt"] = True
            break
        try:
            child.wait(timeout=0.1)
        except subprocess.TimeoutExpired:
            pass
finally:
    if child is not None and child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL); child.wait()
    result["cliExitCode"] = child.returncode if child is not None else None
    if config.read_bytes() == modified:
        config.write_bytes(original_config)
        result["isolatedConfigRestored"] = True
    else:
        result["isolatedConfigRestored"] = False
        result["configExternalChange"] = "Preserved external change; original backup retained"
    (attempt / "result.json").write_text(json.dumps(result, indent=2))

after = native("export", session)
(attempt / "after-export.json").write_text(json.dumps(after, indent=2))
prefix_ok = after["messages"][:len(before["messages"])] == before["messages"]
assert prefix_ok, "Imported native history changed"
new_messages = after["messages"][len(before["messages"]):]
reply = "\n".join(part["text"] for row in new_messages if row["info"]["role"] == "assistant"
                  for part in row["parts"] if part["type"] == "text")
result.update(importedPrefixUnchanged=prefix_ok, reply=reply,
    markerMatched=prior["marker"] in reply, decisionMatched=prior["decision"].casefold() in reply.casefold(),
    sourceUnchanged=hashlib.sha256(source.read_bytes()).hexdigest() == prior["sourceSha256"],
    nativeSessionCount=len(native("session", "list", "--format", "json")),
    newUserTurns=sum(row["info"]["role"] == "user" for row in new_messages),
    usage=[{key: row["info"].get(key) for key in ("id", "modelID", "providerID", "tokens", "cost", "error")}
           for row in new_messages if row["info"]["role"] == "assistant"])
events = [json.loads(row) for row in (attempt / "guard-events.jsonl").read_text().splitlines()]
result["providerDispatches"] = sum(row["event"] == "dispatch" for row in events)
result["providerStatuses"] = [row["status"] for row in events if row["event"] == "response"]
assert result["providerDispatches"] <= 1 and result["newUserTurns"] == 1 and result["nativeSessionCount"] == 1
assert result["sourceUnchanged"]
(attempt / "result.json").write_text(json.dumps(result, indent=2))

# Reopen AgentKib only after restoring the original isolated target config.
# The existing launched receipt prevents another import or terminal launch.
launch_request = None
for line in (case / "rpc.jsonl").read_text().splitlines():
    request = json.loads(line).get("request", {})
    if request.get("method") == "sessions.continueHandoff":
        launch_request = request["params"]
        break
assert launch_request is not None
rpc_child = subprocess.Popen([str(runtime)], env=env, cwd=workspace, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    stderr=(attempt / "runtime.stderr").open("w"))
seq, buffer = 0, b""


def rpc(method, params):
    global seq, buffer
    seq += 1
    rpc_child.stdin.write((json.dumps({"jsonrpc": "2.0", "id": seq, "method": method, "params": params}) + "\n").encode())
    rpc_child.stdin.flush()
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if b"\n" not in buffer:
            assert select.select([rpc_child.stdout], [], [], max(0, deadline - time.monotonic()))[0], "readonly RPC timeout"
            chunk = os.read(rpc_child.stdout.fileno(), 65536); assert chunk
            buffer += chunk
        line, buffer = buffer.split(b"\n", 1)
        row = json.loads(line)
        if row.get("id") == seq:
            assert "error" not in row, row
            return row["result"]
    raise TimeoutError("readonly RPC")


try:
    rpc("agentkib.handshake", {"protocolVersion": 15, "client": {"name": "interop-once-readonly", "version": "1"}})
    found = rpc("sessions.nativeImports", {"workspaceId": operation["launch_request"]["workspace_id"]})
    assert len(found) == 1 and found[0]["status"] == "launched" and found[0]["target_session_id"] == session
    assert found[0]["launch_request"]["operation_id"] == operation["launch_request"]["operation_id"]
    recovered = rpc("sessions.continueHandoff", launch_request)
    assert recovered["status"] == "launched", recovered
    result["runtimeExistingOperationReconciled"] = True
finally:
    if rpc_child.poll() is None:
        rpc("agentkib.shutdown", {})
        rpc_child.stdin.close(); rpc_child.wait(timeout=15)
    (attempt / "result.json").write_text(json.dumps(result, indent=2))
final = native("export", session)
assert final["messages"] == after["messages"], "Readonly Runtime recovery changed native history"
assert len(native("session", "list", "--format", "json")) == 1
result["readonlyRecoveryDidNotSendOrCreate"] = True
result["realReplyPassed"] = (result["markerMatched"] and result["decisionMatched"]
    and result["providerDispatches"] == 1 and result["providerStatuses"] == [200]
    and result["cliExitCode"] == 0 and all(not row["error"] for row in result["usage"]))
(attempt / "result.json").write_text(json.dumps(result, indent=2))
print(json.dumps(result))
