"""Isolated, synthetic public-RPC native import acceptance. No model call.

Usage: python main-interop-rpc.py RUNTIME TOOLS_ROOT NEW_CASE TARGET
TARGET is opencode, hermes, or openclaw. Installs are supplied separately.
An official terminal is opened by the production continuation endpoint.
"""
import hashlib
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import time
import uuid
from interop_native_readback import validate_receipts, verify

runtime, tools, case, target = sys.argv[1:]
wire_target = "open-claw" if target == "openclaw" else target
runtime, tools, case = map(lambda p: Path(p).resolve(), (runtime, tools, case))
if case.exists():
    raise SystemExit("Case must be new")
case.mkdir(mode=0o700, parents=True)
workspace = case / "workspace"
workspace.mkdir()
env = {
    "PATH": ":".join(map(str, [tools / "bin", tools / "opencode/node_modules/.bin",
        tools / "openclaw/node_modules/.bin", Path("/opt/homebrew/bin"), Path("/usr/bin"), Path("/bin")])),
    "HOME": str(case / "home"), "LANG": "en_US.UTF-8",
    "CLAUDE_CONFIG_DIR": str(case / "claude"),
    "HERMES_HOME": str(case / "hermes"),
    "AGENTKIB_BENCHMARK_DATA_DIR": str(case / "data"),
    "OPENCODE_DISABLE_AUTOUPDATE": "true", "OPENCODE_DISABLE_DEFAULT_PLUGINS": "true",
    "OPENCODE_DISABLE_MODELS_FETCH": "true", "HERMES_STATE_DB_TEST_MODE": "1",
    "OPENCLAW_STATE_DIR": str(case / "openclaw"),
    "OPENCLAW_CONFIG_PATH": str(case / "openclaw/openclaw.json"),
}
for xdg in ("DATA", "CONFIG", "STATE", "CACHE"):
    env[f"XDG_{xdg}_HOME"] = str(case / xdg.lower())
for key in ("HOME", "HERMES_HOME", "AGENTKIB_BENCHMARK_DATA_DIR"):
    Path(env[key]).mkdir(exist_ok=True)
config = Path(env["XDG_CONFIG_HOME"]) / "opencode/opencode.json"
config.parent.mkdir(parents=True)
config.write_text(json.dumps({"model": "opencode/big-pickle", "small_model": "opencode/big-pickle",
    "share": "disabled", "autoupdate": False, "permission": "deny"}))
if target == "openclaw":
    fixture = Path(__file__).with_name("openclaw-sqlite-fixtures.mjs")
    subprocess.run(["/opt/homebrew/bin/node", str(fixture), str(tools / "openclaw/node_modules/openclaw"),
        env["OPENCLAW_STATE_DIR"]], env=env, check=True, capture_output=True)
    workspace = case / "openclaw/workspace"

source_id, marker = str(uuid.uuid4()), "AKIB-" + uuid.uuid4().hex[:18]
decision = "append-only SQLite WAL with namespace cobalt-lake"
source = case / "claude/projects/synthetic" / (source_id + ".jsonl")
source.parent.mkdir(parents=True)
rows = []
parent = None
for role, text in [("user", f"Remember marker {marker}; project decision: {decision}."),
                   ("assistant", f"Confirmed {marker} and {decision}.")]:
    turn = str(uuid.uuid4())
    rows.append(dict(type=role, uuid=turn, parentUuid=parent, sessionId=source_id, cwd=str(workspace),
        timestamp="2026-09-30T12:00:00.000Z", message=dict(role=role, content=text)))
    parent = turn
source.write_text("".join(json.dumps(row) + "\n" for row in rows))
source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
(case / "data/preferences.json").write_text(json.dumps({"mcp_network": {"port": port,
    "lan_enabled": False, "lan_risk_accepted": False}}))
(case / "environment.json").write_text(json.dumps(env, indent=2))
log = (case / "rpc.jsonl").open("w")
sequence = 0
child = None
buffer = b""

def start():
    global child, buffer
    buffer = b""
    child = subprocess.Popen([str(runtime)], cwd=workspace, env=env, stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=(case / "runtime.stderr").open("ab"))

def rpc(method, params):
    global sequence, buffer
    sequence += 1
    request = dict(jsonrpc="2.0", id=sequence, method=method, params=params)
    log.write(json.dumps({"request": request}) + "\n"); log.flush()
    child.stdin.write((json.dumps(request) + "\n").encode()); child.stdin.flush()
    deadline = time.monotonic() + 150
    while time.monotonic() < deadline:
        if b"\n" not in buffer:
            assert select.select([child.stdout], [], [], max(0, deadline-time.monotonic()))[0], "RPC timeout"
            chunk = os.read(child.stdout.fileno(), 65536)
            assert chunk, "Runtime exited"
            buffer += chunk
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            row = json.loads(line)
            if row.get("id") == sequence:
                log.write(json.dumps({"response": row}) + "\n"); log.flush()
                assert "error" not in row, row
                return row["result"]
    raise RuntimeError("RPC timeout")

def stop():
    if child is not None and child.poll() is None:
        rpc("agentkib.shutdown", {})
        child.stdin.close()
        child.wait(timeout=15)

result = dict(target=target, marker=marker, decision=decision, source=str(source),
    sourceSha256=source_hash, runtimeSha256=hashlib.sha256(runtime.read_bytes()).hexdigest(),
    modelRequests=0)
try:
    start()
    rpc("agentkib.handshake", {"protocolVersion": 15, "client": {"name": "isolated-interop-qa", "version": "1"}})
    ws = rpc("workspace.add", {"path": str(workspace)})
    wid = ws["id"]
    sessions = rpc("workspace.refreshSessions", {"workspaceId": wid, "force": True})
    candidates = [s for s in sessions if s["agent"] == "claude-code"]
    assert len(candidates) == 1, sessions
    sid = candidates[0]["id"]
    prepared = rpc("sessions.prepareHandoff", {"request": {"session_id": sid, "target_agent": wire_target,
        "format": "markdown", "history_budget_tokens": 64000}})
    draft = prepared["draft"]
    assert draft["mode"] == "native-session", draft
    plan = rpc("sessions.planHandoff", {"sessionId": sid, "workspaceId": wid,
        "filename": draft["filename"], "format": "markdown", "targetAgent": wire_target,
        "mode": draft["mode"], "sourceFingerprint": draft["source_fingerprint"],
        "targetFingerprint": draft["target_fingerprint"], "acceptLosses": True,
        "historyBudgetTokens": 64000})
    request = {"changeSet": plan["change_set"], "launchRequest": plan["launch_request"], "approveHome": True}
    result["first"] = rpc("sessions.continueHandoff", request)
    result["operations"] = rpc("sessions.nativeImports", {"workspaceId": wid})
    result["repeat"] = rpc("sessions.continueHandoff", request)
    stop(); start()
    rpc("agentkib.handshake", {"protocolVersion": 15, "client": {"name": "isolated-interop-qa", "version": "1"}})
    result["afterRestart"] = rpc("sessions.nativeImports", {"workspaceId": wid})
    result["repeatAfterRestart"] = rpc("sessions.continueHandoff", request)
    validate_receipts(result)
    result["sourceUnchanged"] = hashlib.sha256(source.read_bytes()).hexdigest() == source_hash
    assert result["sourceUnchanged"]
except BaseException as error:
    result["error"] = repr(error)
    raise
finally:
    try:
        stop()
    finally:
        (case / "result.json").write_text(json.dumps(result, indent=2))
if "error" not in result:
    verify(case)
