"""Isolated, synthetic public-RPC native import acceptance. No model call.

Usage: python main-interop-rpc.py RUNTIME TOOLS_ROOT NEW_CASE TARGET [SOURCE]
TARGET is opencode, hermes, openclaw, claude-code, or codex. Installs are supplied separately.
File targets require AGENTKIB_QA_TARGET_BINARY pointing to the fixed native CLI.
SOURCE is claude-code (default), codex, grok-build, hermes, cursor, opencode, or open-claw. All records are synthetic.
An official terminal is opened by the production continuation endpoint.
AGENTKIB_QA_OPENCODE_CONFIG may select an explicit credential-free isolated model config.
"""
import hashlib
import json
import os
from pathlib import Path
import select
import socket
import sqlite3
import subprocess
import sys
import time
import uuid
from interop_native_readback import validate_receipts, verify

if len(sys.argv) not in (5, 6):
    raise SystemExit(__doc__)
runtime, tools, case, target = sys.argv[1:5]
source_agent = sys.argv[5] if len(sys.argv) == 6 else "claude-code"
if target not in ("opencode", "hermes", "openclaw", "claude-code", "codex") or source_agent not in ("claude-code", "codex", "grok-build", "hermes", "cursor", "opencode", "open-claw"):
    raise SystemExit("Unsupported acceptance direction")
wire_target = "open-claw" if target == "openclaw" else target
runtime, tools, case = map(lambda p: Path(p).resolve(), (runtime, tools, case))
if case.exists():
    raise SystemExit("Case must be new")
case.mkdir(mode=0o700, parents=True)
workspace = case / "workspace"
workspace.mkdir()
file_target = target in ("claude-code", "codex")
if file_target:
    binary = Path(os.environ["AGENTKIB_QA_TARGET_BINARY"]).resolve(strict=True)
    (case / "bin").mkdir()
    (case / "bin" / ("claude" if target == "claude-code" else "codex")).symlink_to(binary)
env = {
    "PATH": ":".join(map(str, [case / "bin", tools / "bin", tools / "opencode/node_modules/.bin",
        tools / "openclaw/node_modules/.bin", Path("/opt/homebrew/bin"), Path("/usr/bin"), Path("/bin")])),
    "HOME": str(case / "home"), "LANG": "en_US.UTF-8",
    "CLAUDE_CONFIG_DIR": str(case / "claude"),
    "CODEX_HOME": str(case / "codex"), "GROK_HOME": str(case / "grok"),
    "CURSOR_CONFIG_DIR": str(case / "cursor"),
    "HERMES_HOME": str(case / "hermes"),
    "AGENTKIB_BENCHMARK_DATA_DIR": str(case / "data"),
    "OPENCODE_DISABLE_AUTOUPDATE": "true", "OPENCODE_DISABLE_DEFAULT_PLUGINS": "true",
    "OPENCODE_DISABLE_MODELS_FETCH": "true", "HERMES_STATE_DB_TEST_MODE": "1",
    "OPENCLAW_STATE_DIR": str(case / "openclaw"),
    "OPENCLAW_CONFIG_PATH": str(case / "openclaw/openclaw.json"),
    "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
}
for xdg in ("DATA", "CONFIG", "STATE", "CACHE"):
    env[f"XDG_{xdg}_HOME"] = str(case / xdg.lower())
for key in ("HOME", "HERMES_HOME", "AGENTKIB_BENCHMARK_DATA_DIR"):
    Path(env[key]).mkdir(exist_ok=True)
# The official Hermes --version otherwise performs a synchronous update check.
# Keep this synthetic acceptance independent of GitHub latency; user config is untouched.
(case / "hermes/config.yaml").write_text("updates:\n  check: false\n")
config = Path(env["XDG_CONFIG_HOME"]) / "opencode/opencode.json"
config.parent.mkdir(parents=True)
opencode_config = {"model": "opencode/big-pickle", "small_model": "opencode/big-pickle",
    "share": "disabled", "autoupdate": False, "permission": "deny"}
if config_path := os.environ.get("AGENTKIB_QA_OPENCODE_CONFIG"):
    assert target == "opencode", "Custom OpenCode config requires an OpenCode target"
    opencode_config = json.loads(Path(config_path).read_text())
    def reject_credentials(value):
        if isinstance(value, dict):
            assert not any(key.lower().replace("_", "") in ("apikey", "authorization", "token", "password") for key in value), "Credentials must not enter acceptance config"
            for item in value.values():
                reject_credentials(item)
        elif isinstance(value, list):
            for item in value:
                reject_credentials(item)
    reject_credentials(opencode_config)
    assert opencode_config.get("permission") == "deny"
config.write_text(json.dumps(opencode_config))
if target == "openclaw":
    fixture = Path(__file__).with_name("openclaw-sqlite-fixtures.mjs")
    subprocess.run(["/opt/homebrew/bin/node", str(fixture), str(tools / "openclaw/node_modules/openclaw"),
        env["OPENCLAW_STATE_DIR"]], env=env, check=True, capture_output=True)
    workspace = case / "openclaw/workspace"

source_id, marker = str(uuid.uuid4()), "AKIB-" + uuid.uuid4().hex[:18]
decision = "append-only SQLite WAL with namespace cobalt-lake"
if source_agent == "codex":
    source = case / "codex/sessions/2026/09/30" / ("rollout-" + source_id + ".jsonl")
elif source_agent == "grok-build":
    source = case / "grok/sessions/synthetic" / source_id / "chat_history.jsonl"
elif source_agent == "hermes":
    source = case / "hermes/sessions" / (source_id + ".jsonl")
elif source_agent == "opencode":
    source = case / "opencode-source.json"
elif source_agent == "open-claw":
    source = case / "openclaw-source.json"
elif source_agent == "cursor":
    source = case / "cursor/chats/synthetic" / source_id / "store.db"
else:
    source = case / "claude/projects/synthetic" / (source_id + ".jsonl")
source.parent.mkdir(parents=True, exist_ok=True)
rows = []
source_metadata = []
if source_agent == "codex":
    rows.append(dict(type="session_meta", timestamp="2026-09-30T12:00:00Z", payload=dict(
        id=source_id, cwd=str(workspace), timestamp="2026-09-30T12:00:00Z",
        originator="codex-tui", cli_version="0.146.0", source="cli")))
    database = case / "codex/state_1.sqlite"
    with sqlite3.connect(database) as db:
        db.execute("CREATE TABLE threads(id TEXT, rollout_path TEXT, cwd TEXT, title TEXT)")
        db.execute("INSERT INTO threads VALUES (?,?,?,?)", (source_id, str(source), str(workspace), "Synthetic Codex source"))
    source_metadata.append(database)
elif source_agent == "grok-build":
    summary = source.with_name("summary.json")
    summary.write_text(json.dumps({"info": {"id": source_id, "cwd": str(workspace)}}))
    source_metadata.append(summary)
elif source_agent == "hermes":
    rows.append(dict(type="session", id=source_id, cwd=str(workspace)))
parent = None
for role, text in [("user", f"Remember marker {marker}; project decision: {decision}."),
                   ("assistant", f"Confirmed {marker} and {decision}.")]:
    turn = str(uuid.uuid4())
    if source_agent == "codex":
        rows.append(dict(type="response_item", payload=dict(type="message", role=role,
            content=[dict(type="input_text" if role == "user" else "output_text", text=text)])))
    elif source_agent == "grok-build":
        rows.append(dict(type=role, content=text))
    elif source_agent == "hermes":
        rows.append(dict(role=role, content=text))
    else:
        rows.append(dict(type=role, uuid=turn, parentUuid=parent, sessionId=source_id, cwd=str(workspace),
            timestamp="2026-09-30T12:00:00.000Z", message=dict(role=role, content=text)))
    parent = turn
native_source = None
if source_agent == "opencode":
    from opencode_source_fixture import seed_source
    native_source = seed_source(tools / "opencode/node_modules/.bin/opencode", source, source_id,
        workspace, [(row["message"]["role"], row["message"]["content"]) for row in rows], env)
    source_metadata.append(Path(native_source["snapshot"]))
elif source_agent == "open-claw":
    spec = {"package": str(tools / "openclaw/node_modules/openclaw"), "state": env["OPENCLAW_STATE_DIR"],
        "workspace": str(workspace), "sessionId": source_id,
        "sessionKey": "agent:main:agentkib:" + source_id, "title": "Synthetic source " + marker,
        "messages": [(row["message"]["role"], row["message"]["content"]) for row in rows]}
    source.write_text(json.dumps(spec))
    script = Path(__file__).with_name("openclaw-source-fixture.mjs").resolve()
    seeded = subprocess.run(["/opt/homebrew/bin/node", str(script), "seed", str(source)], env=env,
        capture_output=True, check=True, timeout=30)
    snapshot = source.with_suffix(".native.json")
    snapshot.write_bytes(seeded.stdout)
    native_source = {"sessionId": source_id, "snapshot": str(snapshot), "script": str(script),
        "spec": str(source), "title": spec["title"]}
    source_metadata.append(snapshot)
elif source_agent == "cursor":
    # Same graph/fields as the official 2026.09.26 serializer fixture in tests/fixtures.
    # Only an isolated synthetic source is written, never a user's native store.
    def field(number, value):
        value = value.encode() if isinstance(value, str) else value
        size, prefix = len(value), bytearray([number * 8 + 2])
        while size >= 128:
            prefix.append((size & 127) | 128)
            size >>= 7
        prefix.append(size)
        return bytes(prefix) + value

    blobs = {}
    def blob(value):
        key = hashlib.sha256(value).digest()
        blobs[key.hex()] = value
        return key

    user = blob(field(1, rows[0]["message"]["content"]) + field(2, "synthetic-user"))
    assistant = blob(field(1, field(1, rows[1]["message"]["content"])))
    conversation = blob(field(1, field(1, user) + field(2, assistant)))
    root_blob = blob(field(8, conversation) + field(9, workspace.as_uri()))
    metadata = dict(agentId=source_id, latestRootBlobId=root_blob.hex(),
                    name="Synthetic Cursor source", mode="default", createdAt=1790770000000)
    with sqlite3.connect(source) as db:
        db.executescript("PRAGMA user_version=1; CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB);")
        db.executemany("INSERT INTO blobs VALUES (?,?)", blobs.items())
        db.execute("INSERT INTO meta VALUES ('0',?)", (json.dumps(metadata).encode().hex(),))
else:
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

def rpc(method, params, allow_error=False):
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
                if "error" in row:
                    assert allow_error, row
                    return {"rpcError": row["error"]}
                return row["result"]
    raise RuntimeError("RPC timeout")

def stop():
    if child is not None and child.poll() is None:
        rpc("agentkib.shutdown", {})
        child.stdin.close()
        child.wait(timeout=15)

result = dict(target=target, marker=marker, decision=decision, source=str(source),
    sourceSha256=source_hash, runtimeSha256=hashlib.sha256(runtime.read_bytes()).hexdigest(),
    sourceAgent=source_agent,
    nativeSource=native_source,
    sourceMetadata=[dict(path=str(p), sha256=hashlib.sha256(p.read_bytes()).hexdigest()) for p in source_metadata],
    modelRequests=0)
try:
    start()
    rpc("agentkib.handshake", {"protocolVersion": 15, "client": {"name": "isolated-interop-qa", "version": "1"}})
    ws = rpc("workspace.add", {"path": str(workspace)})
    wid = ws["id"]
    sessions = rpc("workspace.refreshSessions", {"workspaceId": wid, "force": True})
    candidates = [s for s in sessions if s["agent"] == source_agent]
    if source_agent == "open-claw":
        candidates = [s for s in candidates if s["title"] == native_source["title"]]
    assert len(candidates) == 1, sessions
    sid = candidates[0]["id"]
    prepared = rpc("sessions.prepareHandoff", {"request": {"session_id": sid, "target_agent": wire_target,
        "format": "markdown", "history_budget_tokens": 64000}})
    draft = prepared["draft"]
    assert draft["mode"] == "native-session", draft
    plan = rpc("sessions.planHandoff", {"sessionId": sid, "workspaceId": wid,
        "filename": draft["filename"], "format": "markdown", "targetAgent": wire_target,
        "mode": draft["mode"], "sourceFingerprint": draft["source_fingerprint"],
        "targetFingerprint": draft.get("target_fingerprint"), "acceptLosses": True,
        "historyBudgetTokens": 64000})
    request = {"changeSet": plan["change_set"], "launchRequest": plan["launch_request"], "approveHome": True}
    if file_target:
        (case / "file-plan.json").write_text(json.dumps(plan, indent=2))
    result["first"] = rpc("sessions.continueHandoff", request)
    if not file_target:
        result["operations"] = rpc("sessions.nativeImports", {"workspaceId": wid})
    result["repeat"] = rpc("sessions.continueHandoff", request, allow_error=file_target)
    stop(); start()
    rpc("agentkib.handshake", {"protocolVersion": 15, "client": {"name": "isolated-interop-qa", "version": "1"}})
    if file_target:
        result["reopen"] = rpc("sessions.launchHandoff", plan["launch_request"])
    else:
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
    if file_target:
        from interop_file_readback import verify_file_case
        verify_file_case(case)
    else:
        verify(case)
