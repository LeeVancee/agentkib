"""Synthetic Codex -> Claude through public Runtime preview/ChangeSet/launch.

Usage: python claude-public-import.py RUNTIME CLAUDE_BINARY NEW_CASE
Opens native terminals without submitting a prompt. No model credentials supplied.
"""
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import socket
import sqlite3
import subprocess
import sys
import time
import uuid
from claude_import_validation import validate_duplicate

runtime, claude, case = [Path(p).resolve() for p in sys.argv[1:]]
case.mkdir(mode=0o700, parents=True, exist_ok=False)
for name in ("workspace", "home", "codex", "claude", "data", "bin"):
    (case / name).mkdir()
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
(case / "data/preferences.json").write_text(json.dumps({"mcp_network": {
    "port": port, "lan_enabled": False, "lan_risk_accepted": False}}))
(case / "bin/claude").symlink_to(claude)
workspace = case / "workspace"
env = {"HOME": str(case / "home"), "PATH": str(case / "bin") + ":/usr/bin:/bin",
       "CLAUDE_CONFIG_DIR": str(case / "claude"), "CODEX_HOME": str(case / "codex"),
       "AGENTKIB_BENCHMARK_DATA_DIR": str(case / "data"), "LANG": "en_US.UTF-8",
       "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"}
(case / "environment.json").write_text(json.dumps(env, indent=2))
native_id = str(uuid.uuid4())
marker = "AKIB-CLAUDE-" + uuid.uuid4().hex
decision = "append-only SQLite WAL with namespace cobalt-lake"
source = case / "codex/source.jsonl"
messages = [("user", f"Remember marker {marker}; project decision: {decision}."),
            ("assistant", f"Confirmed {marker} and {decision}.")]
records = [{"type": "session_meta", "payload": {"id": native_id, "cwd": str(workspace),
    "source": "cli", "cli_version": "0.146.1", "timestamp": "2026-09-30T12:00:00Z"}}]
records.extend({"type": "response_item", "payload": {"type": "message", "role": role,
    "content": [{"type": "input_text" if role == "user" else "output_text", "text": text}]}}
    for role, text in messages)
source.write_text("\n".join(json.dumps(row) for row in records) + "\n")
database = case / "codex/state_1.sqlite"
with sqlite3.connect(database) as db:
    db.execute("CREATE TABLE threads(id TEXT, rollout_path TEXT, cwd TEXT, title TEXT)")
    db.execute("INSERT INTO threads VALUES (?,?,?,?)", (native_id, str(source), str(workspace), "Synthetic source"))
originals = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in (source, database)}
result = {"sourceAgent": "codex", "target": "claude-code", "marker": marker, "decision": decision,
          "sourceFiles": originals, "runtimeSha256": hashlib.sha256(runtime.read_bytes()).hexdigest(),
          "modelRequests": 0}
log = (case / "rpc.jsonl").open("w")
child, seq, buffer = None, 0, b""


def start():
    global child, buffer
    buffer = b""
    child = subprocess.Popen([str(runtime)], env=env, cwd=workspace, stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=(case / "runtime.stderr").open("ab"), start_new_session=True)


def rpc(method, params, allow_error=False):
    global seq, buffer
    seq += 1
    request = {"jsonrpc": "2.0", "id": seq, "method": method, "params": params}
    log.write(json.dumps({"request": request}) + "\n"); log.flush()
    child.stdin.write((json.dumps(request) + "\n").encode()); child.stdin.flush()
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        if b"\n" not in buffer:
            assert select.select([child.stdout], [], [], max(0, deadline - time.monotonic()))[0]
            data = os.read(child.stdout.fileno(), 65536)
            assert data, "Runtime exited"
            buffer += data
        while b"\n" in buffer:
            line, buffer = buffer.split(b"\n", 1)
            row = json.loads(line)
            if row.get("id") == seq:
                log.write(json.dumps({"response": row}) + "\n"); log.flush()
                if "error" in row:
                    assert allow_error, row
                    return {"rpcError": row["error"]}
                return row["result"]
    raise TimeoutError(method)


def stop():
    if child is None or child.poll() is not None:
        return
    try:
        rpc("agentkib.shutdown", {})
        child.stdin.close()
        child.wait(timeout=15)
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL); child.wait()


def handshake():
    rpc("agentkib.handshake", {"protocolVersion": 15, "client": {"name": "claude-import-qa", "version": "1"}})


try:
    start(); handshake()
    wid = rpc("workspace.add", {"path": str(workspace)})["id"]
    candidates = [row for row in rpc("workspace.refreshSessions", {"workspaceId": wid, "force": True}) if row["agent"] == "codex"]
    assert len(candidates) == 1
    sid = candidates[0]["id"]
    draft = rpc("sessions.prepareHandoff", {"request": {"session_id": sid, "target_agent": "claude-code",
        "format": "markdown", "history_budget_tokens": 64000}})["draft"]
    assert draft["mode"] == "native-session", draft
    plan = rpc("sessions.planHandoff", {"sessionId": sid, "workspaceId": wid, "filename": draft["filename"],
        "format": "markdown", "targetAgent": "claude-code", "mode": "native-session",
        "sourceFingerprint": draft["source_fingerprint"], "targetFingerprint": draft.get("target_fingerprint"),
        "acceptLosses": True, "historyBudgetTokens": 64000})
    (case / "plan.json").write_text(json.dumps(plan, indent=2))
    launch = plan["launch_request"]
    assert launch["mode"] == "native-session" and launch["target_agent"] == "claude-code"
    path = Path(launch["target_path"])
    assert path.is_relative_to(case / "claude") and not path.exists()
    change, = [row for row in plan["change_set"]["changes"] if row["target"] == str(path)]
    payload = [json.loads(line) for line in change["after"].splitlines()]
    content = [row for row in payload if row["type"] in ("user", "assistant")]
    assert len(content) == 3 and content[0]["type"] == "user"
    assert [(row["message"]["role"], "\n".join(b["text"] for b in row["message"]["content"])) for row in content[1:]] == messages
    assert all(row["sessionId"] == launch["target_session_id"] for row in payload)
    request = {"changeSet": plan["change_set"], "launchRequest": launch, "approveHome": True}
    result["first"] = rpc("sessions.continueHandoff", request)
    assert result["first"]["status"] == "launched", result
    assert path.read_bytes() == change["after"].encode()
    result["duplicate"] = rpc("sessions.continueHandoff", request, allow_error=True)
    validate_duplicate(result["duplicate"], path)
    assert path.read_bytes() == change["after"].encode()
    stop(); start(); handshake()
    result["reopen"] = rpc("sessions.launchHandoff", launch)
    assert result["reopen"]["target_agent"] == "claude-code"
    assert path.read_bytes() == change["after"].encode()
    files = list((case / "claude/projects").rglob("*.jsonl"))
    assert files == [path], files
    assert all(hashlib.sha256(Path(p).read_bytes()).hexdigest() == digest for p, digest in originals.items())
    result.update(targetSessionId=launch["target_session_id"], targetPath=str(path), targetFileCount=1,
                  sourceUnchanged=True, exactPayloadMatched=True, nativeUiVerified=False)
except BaseException as error:
    result["error"] = repr(error)
    raise
finally:
    try:
        stop()
    finally:
        (case / "result.json").write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
