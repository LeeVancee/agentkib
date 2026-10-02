"""Create a synthetic source with the pinned OpenCode official import command."""
import json
from pathlib import Path
import subprocess


def seed_source(executable, source, session_id, workspace, messages, env):
    version = subprocess.run([str(executable), "--version"], env=env, capture_output=True,
                             check=True, timeout=15).stdout.decode().strip()
    assert version == "1.18.32", version
    sid = "ses_" + session_id.replace("-", "")
    tokens = {"input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0}}
    rows = []
    for index, (role, text) in enumerate(messages):
        mid = "msg_" + session_id.replace("-", "") + f"_{index:08d}"
        info = {"id": mid, "sessionID": sid, "role": role,
                "time": {"created": 1790769600000 + index}, "agent": "build"}
        if role == "user":
            info["model"] = {"providerID": "opencode", "modelID": "big-pickle"}
        else:
            info.update(parentID=rows[-1]["info"]["id"], providerID="opencode", modelID="big-pickle",
                        mode="build", path={"cwd": str(workspace), "root": str(workspace)},
                        cost=0, tokens=tokens, finish="stop")
            info["time"]["completed"] = info["time"]["created"]
        rows.append({"info": info, "parts": [{"id": mid.replace("msg_", "prt_") + "_00000000",
            "sessionID": sid, "messageID": mid, "type": "text", "text": text}]})
    payload = {"info": {"id": sid, "slug": "synthetic-" + session_id,
        "projectID": "global", "directory": str(workspace), "title": "Synthetic OpenCode source",
        "version": version, "time": {"created": 1790769600000, "updated": 1790769600001}},
        "messages": rows}
    Path(source).write_text(json.dumps(payload))
    imported = subprocess.run([str(executable), "import", str(source)], env=env, cwd=workspace,
                              capture_output=True, check=True, timeout=30)
    Path(source).with_suffix(".import.log").write_bytes(imported.stdout + imported.stderr)
    actual = export_source(executable, sid, workspace, env)
    assert [(row["info"]["role"], "\n".join(p["text"] for p in row["parts"]))
            for row in actual["messages"]] == messages
    snapshot = Path(source).with_suffix(".native.json")
    snapshot.write_text(json.dumps(actual, sort_keys=True))
    return {"sessionId": sid, "executable": str(executable), "workspace": str(workspace),
            "snapshot": str(snapshot)}


def export_source(executable, session_id, workspace, env):
    return json.loads(subprocess.run([str(executable), "export", session_id], env=env,
        cwd=workspace, check=True, capture_output=True, timeout=30).stdout)
