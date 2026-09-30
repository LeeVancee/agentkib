"""Read-only verification of an existing isolated main-interop-rpc case."""
import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys


def validate_receipts(result):
    for name in ("first", "repeat", "repeatAfterRestart"):
        assert result[name]["status"] == "launched", (name, result[name])
    before, after = result["operations"], result["afterRestart"]
    assert len(before) == len(after) == 1
    assert before[0]["status"] == after[0]["status"] == "launched"
    assert before[0]["target_session_id"] == after[0]["target_session_id"]
    assert before[0]["launch_request"] == after[0]["launch_request"]
    assert before[0]["target_session_id"]


def exact(actual, expected):
    assert actual == expected, "Native roles, order, or complete text differ from reviewed projection"


def verify(case):
    case = Path(case).resolve()
    result = json.loads((case / "result.json").read_text())
    validate_receipts(result)
    assert hashlib.sha256(Path(result["source"]).read_bytes()).hexdigest() == result["sourceSha256"]
    plan_file, = (case / "data/continuations").rglob("plan.json")
    assert hashlib.sha256(plan_file.read_bytes()).hexdigest() == result["operations"][0]["launch_request"]["plan_hash"]
    plan = json.loads(plan_file.read_text())
    env = json.loads((case / "environment.json").read_text())
    sid = result["operations"][0]["target_session_id"]
    expected = [[t["role"], "\n".join(b["text"] for b in t["blocks"] if b["type"] == "text")]
                for t in plan["expected"]["turns"]]
    if result["target"] == "opencode":
        def run(*args):
            output = subprocess.run([plan["executable"], *args], env=env, cwd=plan["workspace"],
                                    check=True, capture_output=True, timeout=30)
            return json.loads(output.stdout)
        native = run("export", sid)
        actual = [[m["info"]["role"], "\n".join(p["text"] for p in m["parts"] if p["type"] == "text")]
                  for m in native["messages"]]
        assert all(p["type"] == "text" for m in native["messages"] for p in m["parts"])
        exact(actual, expected)
        sessions = run("session", "list", "--format", "json")
        assert len(sessions) == 1 and sessions[0]["id"] == sid
        total = len(sessions)
    elif result["target"] == "hermes":
        with sqlite3.connect("file:" + str(case / "hermes/state.db") + "?mode=ro", uri=True) as db:
            actual = [list(row) for row in db.execute("SELECT role,content FROM messages WHERE session_id=? ORDER BY id", (sid,))]
            exact(actual, expected)
            total = db.execute("SELECT count(*) FROM sessions").fetchone()[0]
            assert total == 1
            native = {"messages": actual, "session_id": sid}
    else:
        script = """
import {pathToFileURL} from 'node:url';
const p=JSON.parse(process.argv[1]);
const load=n=>import(pathToFileURL(p.openclaw.package+'/dist/'+n));
const {n:readOnly}=await load('openclaw-agent-db-readonly-IBx2zWDG.mjs');
const {l:events}=await load('session-accessor.sqlite-read-DG0i0-yW.mjs');
const out=readOnly(d=>({events:events(d,p.target_session_id),count:d.db.prepare('SELECT COUNT(*) AS n FROM session_nodes').get().n,
 matches:d.db.prepare('SELECT COUNT(*) AS n FROM session_nodes WHERE current_session_id=?').get(p.target_session_id).n}),
 {agentId:p.openclaw.agent_id,env:process.env,path:p.openclaw.agent_dir+'/openclaw-agent.sqlite'});
if(!out.found)throw Error('Native database unavailable');
console.log(JSON.stringify(out.value));
"""
        output = subprocess.run([plan["openclaw"]["node"], "--input-type=module", "-e", script, json.dumps(plan)],
                                env=env, cwd=plan["workspace"], check=True, capture_output=True, timeout=30)
        native = json.loads(output.stdout)
        exact(native["events"], json.loads(plan["payload"]))
        # The official fixture creates five distinct baseline sessions before import.
        assert native["count"] == 6 and native["matches"] == 1, native
        total = native["count"]
    (case / "independent-native-readback.json").write_text(json.dumps(native, indent=2))
    verified = {"receiptsAndStableIdentity": True, "exactProjectionMatched": True,
                "sourceUnchanged": True, "nativeTotalSessions": total, "importedSessionCount": 1,
                "modelRequestSent": False}
    (case / "independent-verification.json").write_text(json.dumps(verified, indent=2))
    return verified


def self_test():
    entry = {"status": "launched", "target_session_id": "target", "launch_request": {"operation_id": "op"}}
    good = {"first": {"status": "launched"}, "repeat": {"status": "launched"},
            "repeatAfterRestart": {"status": "launched"}, "operations": [entry], "afterRestart": [copy.deepcopy(entry)]}
    validate_receipts(good)
    bad = copy.deepcopy(good); bad["first"]["status"] = "import-outcome-unknown"
    drift = copy.deepcopy(good); drift["afterRestart"][0]["target_session_id"] = "other"
    for run in (lambda: validate_receipts(bad), lambda: validate_receipts(drift),
                lambda: exact([["user", "changed"]], [["user", "reviewed"]])):
        try:
            run()
        except AssertionError:
            continue
        raise AssertionError("Negative fixture was incorrectly accepted")


if __name__ == "__main__":
    self_test()
    print(json.dumps(verify(sys.argv[1]) if len(sys.argv) > 1 else {"negativeCases": 3, "passed": True}))
