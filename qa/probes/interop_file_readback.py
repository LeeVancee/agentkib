"""Exact local checks for public ChangeSet native-file QA cases, no inference."""
import hashlib
import json
from pathlib import Path
from interop_native_readback import verify_native_source


def verify_file_case(case):
    case = Path(case)
    result = json.loads((case / "result.json").read_text())
    plan = json.loads((case / "file-plan.json").read_text())
    target = result["target"]
    assert target in ("claude-code", "codex")
    launch = plan["launch_request"]
    assert launch["mode"] == "native-session" and launch["target_agent"] == target
    home = case / ("claude" if target == "claude-code" else "codex")
    path = Path(launch["target_path"]).resolve()
    assert path.is_relative_to(home)
    change, = [row for row in plan["change_set"]["changes"] if row["target"] == str(path)]
    assert path.read_bytes() == change["after"].encode()
    rows = [json.loads(line) for line in change["after"].splitlines()]
    if target == "claude-code":
        assert all(row["sessionId"] == launch["target_session_id"] for row in rows)
        assert all(row["type"] in ("user", "assistant", "last-prompt") for row in rows)
        messages = [row for row in rows if row["type"] in ("user", "assistant")]
        last_prompt, = [row for row in rows if row["type"] == "last-prompt"]
        assert last_prompt["lastPrompt"] == "" and last_prompt["leafUuid"] == messages[-1]["uuid"]
        text = [(row["message"]["role"], "\n".join(part["text"] for part in row["message"]["content"])) for row in messages]
    else:
        assert rows[0]["type"] == "session_meta"
        assert rows[0]["payload"]["id"] == launch["target_session_id"]
        assert rows[0]["payload"]["history_mode"] == "legacy"
        assert all(row["type"] in ("session_meta", "response_item", "event_msg") for row in rows)
        text = [(row["payload"]["role"], "\n".join(part["text"] for part in row["payload"]["content"]))
                for row in rows if row["type"] == "response_item"]
        events = [row["payload"] for row in rows if row["type"] == "event_msg"]
        assert all(row["type"] in ("user_message", "agent_message") for row in events)
        assert [("user" if row["type"] == "user_message" else "assistant", row["message"]) for row in events] == text
    assert len(text) == 3 and text[0][0] == "user"
    assert text[1:] == [("user", f'Remember marker {result["marker"]}; project decision: {result["decision"]}.'),
                        ("assistant", f'Confirmed {result["marker"]} and {result["decision"]}.')]
    assert result["first"]["status"] == "launched" and result["first"]["receipt"]["target_agent"] == target
    error = result["repeat"]["rpcError"]
    assert error["code"] == -32000 and error["message"] == "AgentKib command failed"
    assert error["data"]["detail"] == "File was modified externally: " + str(path)
    assert result["reopen"]["target_agent"] == target
    assert hashlib.sha256(Path(result["source"]).read_bytes()).hexdigest() == result["sourceSha256"]
    for item in result["sourceMetadata"]:
        assert hashlib.sha256(Path(item["path"]).read_bytes()).hexdigest() == item["sha256"]
    verify_native_source(result, json.loads((case / "environment.json").read_text()))
    files = set((home / ("projects" if target == "claude-code" else "sessions")).rglob("*.jsonl"))
    expected_files = {path}
    if result["sourceAgent"] == target:
        assert Path(result["source"]).resolve() != path
        expected_files.add(Path(result["source"]))
    assert files == expected_files
    proof = {"sourceUnchanged": True, "exactPayloadMatched": True,
             "sameLaunchRequestAcceptedAfterRuntimeRestart": True,
             "nativeSessionIdentityUnchangedOnDisk": True, "nativeResumeVerified": False,
             "importedSessionCount": 1, "nativeFileCount": len(files), "modelRequests": 0,
             "nativeUiVerified": False}
    (case / "independent-file-verification.json").write_text(json.dumps(proof, indent=2))
    return proof
