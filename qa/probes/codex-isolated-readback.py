"""No-inference pinned Codex native read/resume/restart probe on synthetic data.

Usage: python3 codex-isolated-readback.py CODEX_BINARY NEW_CASE_DIRECTORY [HISTORY_MODE_OR_RENDERER_FIXTURE] [events]
       python3 codex-isolated-readback.py CODEX_BINARY NEW_EVIDENCE_DIRECTORY --existing PUBLIC_CASE
Uses macOS sandbox-exec to deny all network and permits only initialize,
thread/read, thread/list and thread/resume requests. Never sends turn/start.
A fixture path consumes unchanged output from the opt-in Rust renderer test.
Without it the fixture follows the old renderer shape to reproduce failures.
This does not claim
the complete AgentKib preview/ChangeSet path or real model acceptance.
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
import uuid

if len(sys.argv) not in (3, 4, 5) or sys.platform != "darwin":
    raise SystemExit(__doc__)
binary, case = (Path(value).resolve() for value in sys.argv[1:3])
existing_case = Path(sys.argv[4]).resolve() if len(sys.argv) == 5 and sys.argv[3] == "--existing" else None
history_mode = sys.argv[3] if len(sys.argv) >= 4 else "save-all"
fixture_path = Path(history_mode).resolve() if history_mode not in ("save-all", "legacy", "omit", "--existing") else None
if fixture_path is not None and not fixture_path.is_file():
    raise SystemExit("Unknown fixture history mode or missing renderer fixture")
case.mkdir(parents=True, mode=0o700, exist_ok=False)
home, codex_home, workspace = ((existing_case or case) / name for name in ("home", "codex", "workspace"))
if existing_case is None:
    for directory in (home, codex_home, workspace):
        directory.mkdir(mode=0o700)
else:
    assert all(directory.is_dir() for directory in (home, codex_home, workspace))
env = {"HOME": str(home), "CODEX_HOME": str(codex_home), "PATH": "/usr/bin:/bin",
       "TERM": "dumb", "LANG": "en_US.UTF-8"}
profile = "(version 1)(allow default)(deny network*)"
prefix = ["/usr/bin/sandbox-exec", "-p", profile, str(binary)]
version = subprocess.run(prefix + ["--version"], env=env, cwd=workspace,
                         capture_output=True, text=True, check=True, timeout=10).stdout.strip()
verified_binaries = {
    "codex-cli 0.146.1": "35d248101b211d6248ad4e6b8c1d441fe81236da87afb9f3e9ea51a049e9f179",
    "codex-cli 0.155.1": "8eaf1ad12fe6bf89b1710330f58900014322c7c5af677e43be116d8ac5fc0a9e",
}
if version not in verified_binaries or hashlib.sha256(binary.read_bytes()).hexdigest() != verified_binaries[version]:
    raise SystemExit("Unexpected Codex version: " + version)
session_id = str(uuid.uuid4())
marker = "AKIB-CODEX-OFFLINE-" + uuid.uuid4().hex
decision = "append-only SQLite WAL; namespace cobalt-lake"
timestamp = "2026-09-30T12:00:00Z"
rollout = codex_home / "sessions/2026/09/30" / f"rollout-2026-09-30T12-00-00-{session_id}.jsonl"
if existing_case is None:
    rollout.parent.mkdir(parents=True)
texts = [("user", "Imported synthetic context from AgentKib; preserve history without replaying tools."),
         ("user", f"Remember marker {marker}; project decision: {decision}."),
         ("assistant", f"Confirmed {marker}; {decision}.")]
records = [{"timestamp": timestamp, "type": "session_meta", "payload": {
    "id": session_id, "session_id": session_id, "timestamp": timestamp, "cwd": str(workspace),
    "originator": "agentkib", "cli_version": "0.146.1", "source": "exec", "thread_source": "exec",
    "model_provider": "openai"}}]
if history_mode != "omit":
    records[0]["payload"]["history_mode"] = history_mode
for role, text in texts:
    records.append({"timestamp": timestamp, "type": "response_item", "payload": {
        "type": "message", "role": role, "content": [{
            "type": "input_text" if role == "user" else "output_text", "text": text}]}})
if len(sys.argv) == 5 and sys.argv[4] == "events":
    for role, text in texts:
        records.append({"timestamp": timestamp, "type": "event_msg", "payload": {
            "type": "user_message" if role == "user" else "agent_message", "message": text}})
if existing_case is not None:
    public = json.loads((existing_case / "result.json").read_text())
    marker, decision = public["marker"], public["decision"]
    plan_path = existing_case / "plan.json"
    if not plan_path.is_file():
        from interop_file_readback import verify_file_case
        verify_file_case(existing_case)
        plan_path = existing_case / "file-plan.json"
        public["sourceFiles"] = {public["source"]: public["sourceSha256"],
            **{item["path"]: item["sha256"] for item in public["sourceMetadata"]}}
    plan = json.loads(plan_path.read_text())
    launch = plan["launch_request"]
    assert public["target"] == launch["target_agent"] == "codex"
    assert public["first"]["status"] == "launched" and public["reopen"]["target_agent"] == "codex"
    session_id = launch["target_session_id"]
    if "targetSessionId" in public:
        assert public["targetSessionId"] == session_id
    rollout = Path(launch["target_path"]).resolve()
    assert rollout.is_relative_to(codex_home)
    if "targetPath" in public:
        assert str(rollout) == public["targetPath"]
    change, = [row for row in plan["change_set"]["changes"] if row["target"] == str(rollout)]
    original = change["after"].encode()
    assert rollout.read_bytes() == original
    assert all(hashlib.sha256(Path(path).read_bytes()).hexdigest() == digest
               for path, digest in public["sourceFiles"].items())
    records = [json.loads(line) for line in original.splitlines()]
    meta = records[0]["payload"]
    assert meta["id"] == session_id and meta["cwd"] == str(workspace)
    history_mode = meta["history_mode"]
    texts = [(row["payload"]["role"], item["text"]) for row in records
             if row["type"] == "response_item" and row["payload"]["type"] == "message"
             for item in row["payload"]["content"] if item["type"] in ("input_text", "output_text")]
    assert texts[1:] == [("user", f'Remember marker {public["marker"]}; project decision: {public["decision"]}.'),
                         ("assistant", f'Confirmed {public["marker"]} and {public["decision"]}.')]
elif fixture_path is not None:
    records = [json.loads(line) for line in fixture_path.read_text().splitlines() if line.strip()]
    meta = records[0]["payload"]
    if meta["cwd"] != str(workspace):
        raise SystemExit("Renderer fixture workspace must match the new isolated workspace")
    session_id = meta["id"]
    history_mode = meta["history_mode"]
    texts = [(row["payload"]["role"], item["text"]) for row in records
             if row["type"] == "response_item" and row["payload"]["type"] == "message"
             for item in row["payload"]["content"] if item["type"] in ("input_text", "output_text")]
    rollout = rollout.parent / f"rollout-2026-09-30T12-00-00-{session_id}.jsonl"
    original = fixture_path.read_bytes()
else:
    original = ("\n".join(json.dumps(row) for row in records) + "\n").encode()
if existing_case is None:
    rollout.write_bytes(original)
report = {"version": version, "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
          "sessionId": session_id, "marker": marker if fixture_path is None else None,
          "decision": decision,
          "networkDenied": True, "modelRequests": 0, "historyMode": history_mode,
          "rendererFixture": str(fixture_path) if fixture_path else None,
          "publicCase": str(existing_case) if existing_case else None,
          "rolloutSha256": hashlib.sha256(original).hexdigest(), "expectedMessages": texts, "passes": []}
allowed = {"initialize", "thread/read", "thread/list", "thread/resume"}


class Server:
    def __init__(self, index):
        self.log = (case / f"pass-{index}.jsonl").open("w")
        self.stderr = (case / f"pass-{index}.stderr.log").open("w")
        self.process = subprocess.Popen(prefix + ["-c", "check_for_update_on_startup=false",
            "-c", "web_search=\"disabled\"", "-c", "features.shell_snapshot=false", "app-server"],
            env=env, cwd=workspace, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=self.stderr, start_new_session=True)
        self.buffer = b""
        self.sequence = 0

    def send(self, value):
        self.log.write(json.dumps({"direction": "request", "value": value}) + "\n")
        self.log.flush()
        self.process.stdin.write((json.dumps(value) + "\n").encode())
        self.process.stdin.flush()

    def rpc(self, method, params):
        if method not in allowed:
            raise AssertionError("Forbidden RPC: " + method)
        self.sequence += 1
        request_id = self.sequence
        self.send({"id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if b"\n" not in self.buffer:
                ready, _, _ = select.select([self.process.stdout], [], [], deadline - time.monotonic())
                if not ready:
                    break
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    raise RuntimeError("Codex stdout closed")
                self.buffer += chunk
                continue
            line, self.buffer = self.buffer.split(b"\n", 1)
            value = json.loads(line)
            self.log.write(json.dumps({"direction": "response", "value": value}) + "\n")
            self.log.flush()
            if value.get("id") == request_id and "method" not in value:
                return value
        raise TimeoutError(method)

    def stop(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGTERM)
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=5)
        self.stderr.close()
        self.log.close()


try:
    for index in (1, 2):
        server = Server(index)
        results = {"index": index}
        try:
            results["initialize"] = server.rpc("initialize", {"clientInfo": {
                "name": "agentkib_native_readback", "version": "0.13.0"},
                "capabilities": {"experimentalApi": True}})
            server.send({"method": "initialized", "params": {}})
            results["readBeforeResume"] = server.rpc("thread/read", {
                "threadId": session_id, "includeTurns": True})
            results["resume"] = server.rpc("thread/resume", {
                "threadId": session_id, "cwd": str(workspace),
                "approvalPolicy": "never", "sandbox": "read-only"})
            results["readAfterResume"] = server.rpc("thread/read", {
                "threadId": session_id, "includeTurns": True})
            results["list"] = server.rpc("thread/list", {"limit": 20, "sourceKinds": ["exec"], "modelProviders": []})
        finally:
            server.stop()
        report["passes"].append(results)
    report["originalPrefixPreserved"] = rollout.read_bytes().startswith(original)
    report["rolloutFiles"] = [str(path.relative_to(codex_home)) for path in codex_home.rglob("rollout-*.jsonl")]
    report["authFileCreated"] = (codex_home / "auth.json").exists()
    if existing_case is not None:
        assert all(hashlib.sha256(Path(path).read_bytes()).hexdigest() == digest
                   for path, digest in public["sourceFiles"].items())
        if public.get("nativeSource"):
            from interop_native_readback import verify_native_source
            verify_native_source(public, json.loads((existing_case / "environment.json").read_text()))
        report["publicSourceUnchanged"] = True
    report["rpcErrors"] = [{"pass": row["index"], "operation": key, "error": value["error"]}
        for row in report["passes"] for key, value in row.items()
        if isinstance(value, dict) and "error" in value]
    def native_messages(response):
        thread = response.get("result", {}).get("thread", {})
        messages = []
        for turn in thread.get("turns", []):
            if turn["status"] != "completed":
                raise AssertionError("Imported history unexpectedly active")
            for item in turn["items"]:
                if item["type"] == "userMessage":
                    messages.extend(("user", part["text"]) for part in item["content"] if part["type"] == "text")
                elif item["type"] == "agentMessage":
                    messages.append(("assistant", item["text"]))
                else:
                    raise AssertionError("Unexpected native item: " + item["type"])
        return messages
    report["historyTextVisible"] = all(native_messages(row.get(operation, {})) == texts
        for row in report["passes"] for operation in ("readBeforeResume", "resume", "readAfterResume"))
    report["identityMatches"] = all(row.get(operation, {}).get("result", {}).get("thread", {}).get("id") == session_id
        and row.get(operation, {}).get("result", {}).get("thread", {}).get("cwd") == str(workspace)
        for row in report["passes"] for operation in ("readBeforeResume", "resume", "readAfterResume"))
    report["listedExactlyOnce"] = all([item["id"] for item in row.get("list", {}).get("result", {}).get("data", [])] == [session_id]
        for row in report["passes"])
    expected_files = {str(rollout.relative_to(codex_home))}
    if existing_case is not None and public["sourceAgent"] == "codex":
        source_rollouts = [Path(path) for path in public["sourceFiles"]
                          if Path(path).name.startswith("rollout-") and Path(path).suffix == ".jsonl"]
        assert len(source_rollouts) == 1 and source_rollouts[0] != rollout
        expected_files.add(str(source_rollouts[0].relative_to(codex_home)))
    report["passed"] = (not report["rpcErrors"] and report["historyTextVisible"]
        and report["originalPrefixPreserved"] and report["identityMatches"] and report["listedExactlyOnce"]
        and set(report["rolloutFiles"]) == expected_files and not report["authFileCreated"])
except Exception as error:
    report["error"] = type(error).__name__ + ": " + str(error)
finally:
    (case / "result.json").write_text(json.dumps(report, indent=2))
print(json.dumps({"case": str(case), "version": version, "passes": len(report["passes"]),
                  "error": report.get("error"), "passed": report.get("passed"), "modelRequests": 0}))
if "error" in report or not report.get("passed"):
    raise SystemExit(1)
