#!/usr/bin/env python3
"""Exercise a macOS CI candidate's own Electron/Node and packaged backend resources.

No GUI, model, Agent executable, provider configuration or installed application is used.
RunAsNode is required; this probe never modifies Electron fuses or signatures.
"""
import hashlib
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time

assert sys.platform == "darwin"
assert len(sys.argv) == 3, "Usage: smoke-candidate-workers.py CANDIDATE.app REPORT.json"
app = Path(sys.argv[1]).resolve(strict=True)
output = Path(sys.argv[2]).resolve()
executable = app / "Contents/MacOS/AgentKib"
dist = app / "Contents/Resources/app.asar/dist-electron"
root = Path(tempfile.mkdtemp(prefix="agentkib-candidate-workers-")).resolve()
children = []
handles = []
environment = {
    "HOME": str(root), "USERPROFILE": str(root), "TMPDIR": str(root),
    "PATH": "/usr/bin:/bin", "ELECTRON_RUN_AS_NODE": "1",
    "AGENTKIB_HOME": str(root / "library"),
    "CLAUDE_CONFIG_DIR": str(root / ".claude"),
    "CODEX_HOME": str(root / ".codex"),
    "XDG_CONFIG_HOME": str(root / ".config"),
    "XDG_DATA_HOME": str(root / ".local/share"),
    # Keep the GUI isolated too if a future candidate disables the RunAsNode fuse.
    "AGENTKIB_BENCHMARK_DATA_DIR": str(root / "data"),
    "AGENTKIB_BENCHMARK_USER_DATA": str(root / "electron"),
}


def start(arguments):
    errors = (root / f"stderr-{len(children)}.log").open("wb")
    handles.append(errors)
    child = subprocess.Popen(
        [str(executable), *map(str, arguments)], cwd=root, env=environment,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors,
        start_new_session=True, bufsize=0,
    )
    children.append(child)
    return child


def group_alive(child):
    child.poll()  # Reap the direct child before testing group existence.
    try:
        os.killpg(child.pid, 0)
        return True
    except ProcessLookupError:
        return False


def stop(child):
    # These operations use Worker threads only, and never dispatch a detached Agent CLI.
    for sig in (signal.SIGTERM, signal.SIGKILL):
        if not group_alive(child):
            return
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            return
        until = time.monotonic() + 2
        while group_alive(child) and time.monotonic() < until:
            time.sleep(0.025)
    if group_alive(child):
        raise RuntimeError(f"Owned group has not exited; scratch retained: {root}")


def run(arguments):
    child = start(arguments)
    try:
        data, _ = child.communicate(timeout=20)
        assert child.returncode == 0, f"Candidate helper exited {child.returncode}"
        return data.decode()
    finally:
        stop(child)


report = {"scope": "candidate-internal-backend-workers", "candidate": str(app),
          "measuredAt": datetime.now(timezone.utc).isoformat(),
          "guiAccepted": False, "nativeModelAccepted": False, "modelRequests": 0}
try:
    data = root / "data"
    data.mkdir()
    skill = root / ".claude/skills/smoke/SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("---\nname: smoke\ndescription: Isolated packaged Worker smoke\n---\nFixture text.\n")
    source_sha256 = hashlib.sha256(skill.read_bytes()).hexdigest()
    handoff = root / ".agentkib/handoffs/smoke.md"
    handoff.parent.mkdir(parents=True)
    handoff.write_text("Isolated packaged handoff fixture\n")
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    (data / "preferences.json").write_text(json.dumps({
        "session_index_enabled": False,
        "mcp_network": {"port": port, "lan_enabled": False, "lan_risk_accepted": False},
    }))
    report["versions"] = json.loads(run(["--eval", "console.log(JSON.stringify({electron:process.versions.electron,node:process.versions.node,arch:process.arch}))"]))
    backend = start([dist / "backend.cjs"])
    buffer = b""
    sequence = 0
    received = set()

    def rpc(method, params=None):
        global sequence, buffer
        sequence += 1
        backend.stdin.write((json.dumps({"jsonrpc": "2.0", "id": sequence, "method": method, "params": params or {}}) + "\n").encode())
        until = time.monotonic() + 15
        while True:
            while b"\n" in buffer:
                line, buffer = buffer.split(b"\n", 1)
                frame = json.loads(line)
                assert isinstance(frame, dict), "Invalid backend frame"
                if "id" not in frame:
                    continue
                assert frame["id"] not in received, "Duplicate backend response"
                received.add(frame["id"])
                assert frame["id"] == sequence, "Unexpected backend response identity"
                assert "error" not in frame, "Backend RPC failed: " + method
                return frame["result"]
            remaining = until - time.monotonic()
            assert remaining > 0, "Backend RPC timed out: " + method
            ready, _, _ = select.select([backend.stdout], [], [], remaining)
            assert ready, "Backend RPC timed out: " + method
            chunk = os.read(backend.stdout.fileno(), 65536)
            assert chunk, "Backend exited before response: " + method
            buffer += chunk

    rpc("backend.initialize", {"dataDir": str(data)})
    inventory = rpc("skills.inventory")
    observation = next(item for item in inventory["observations"] if item["name"] == "smoke")
    preview = rpc("skills.prepareImport", {"observation_id": observation["id"]})
    rpc("skills.applyOperation", {"token": preview["token"], "confirmed": True})
    assert (root / "library/skills" / preview["library_id"] / "SKILL.md").read_bytes() == skill.read_bytes()
    assert hashlib.sha256(skill.read_bytes()).hexdigest() == source_sha256
    rpc("agentkib.shutdown")
    assert backend.wait(timeout=10) == 0
    stop(backend)
    report["skillsInventoryPreviewApplyShutdown"] = True
    report["backendResponses"] = len(received)

    read_helper = root / "read-worker.cjs"
    read_helper.write_text("""
const assert=require('node:assert/strict'), fs=require('node:fs');
const {Worker}=require('node:worker_threads');
const {DatabaseSync}=require('node:sqlite');
const database=new DatabaseSync(':memory:');database.exec('SELECT 1');database.close();
(async()=>{
 const worker=new Worker(process.argv[2]);let timer;
 try{
  const answer=await new Promise((resolve,reject)=>{
   timer=setTimeout(()=>reject(Error('Handoff Worker timed out')),10000);
   worker.once('message',resolve);worker.once('error',reject);
   worker.postMessage({kind:'read',id:'candidate-smoke',task:{id:'candidate-smoke',deadlineAt:Date.now()+10000},operation:'validate-handoff-file',input:[process.argv[3],'smoke.md']});
  });
  assert.equal(answer.error,undefined);assert.equal(answer.value,fs.realpathSync(process.argv[3]+'/.agentkib/handoffs/smoke.md'));
  console.log(JSON.stringify({handoffWorker:true,nodeSqlite:true}));
 }finally{clearTimeout(timer);await worker.terminate();}
})().catch(error=>{console.error(error);process.exitCode=1;});
""")
    report.update(json.loads(run([read_helper, dist / "backend-handoff-read.cjs", root])))
    native_smoke = Path(__file__).resolve().parents[2] / ".github/scripts/smoke-test-backend-native.mjs"
    report["nativeWorkerOutput"] = run([native_smoke, dist]).strip()
    report["packagedKoffiWorker"] = True
    report["applicationSha256"] = hashlib.sha256(executable.read_bytes()).hexdigest()
    report["asarSha256"] = hashlib.sha256((app / "Contents/Resources/app.asar").read_bytes()).hexdigest()
    report["status"] = "passed"
except Exception as error:
    report["status"] = "failed"
    report["detail"] = str(error)
    raise
finally:
    failures = []
    for child in children:
        try:
            stop(child)
        except Exception as error:
            failures.append(str(error))
    for handle in handles:
        handle.close()
    report["cleanupConfirmed"] = not failures
    if failures:
        report["cleanupErrors"] = failures
        report["scratchRetained"] = str(root)
    else:
        shutil.rmtree(root)
    output.write_text(json.dumps(report, indent=2) + "\n")
    output.chmod(0o600)
    if failures:
        raise RuntimeError("Candidate processes not confirmed stopped; private scratch retained")
print("PASS candidate-internal backend, persistent Skills Worker, Handoff Worker, node:sqlite and packaged Koffi; GUI remains separately unaccepted")
