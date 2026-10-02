"""Pure validation of existing Claude file-import QA evidence; never launches a CLI."""
import copy
import hashlib
import json
from pathlib import Path
import sys


def validate_duplicate(response, target_path):
    if "rpcError" in response:
        error = response["rpcError"]
        assert error["code"] == -32000
        assert error["message"] == "AgentKib command failed"
        assert error.get("data", {}).get("detail") == "File was modified externally: " + str(target_path)
    else:
        assert response.get("status") == "launched"
        assert response.get("receipt", {}).get("target_agent") == "claude-code"


def self_test():
    target = "/synthetic/target.jsonl"
    conflict = {"rpcError": {"code": -32000, "message": "AgentKib command failed",
                             "data": {"detail": "File was modified externally: " + target}}}
    launched = {"status": "launched", "receipt": {"target_agent": "claude-code"}}
    validate_duplicate(conflict, target)
    validate_duplicate(launched, target)
    internal = copy.deepcopy(conflict)
    internal["rpcError"]["data"]["detail"] = "Internal failure"
    wrong_path = copy.deepcopy(conflict)
    wrong_path["rpcError"]["data"]["detail"] += ".different"
    wrong_agent = {"status": "launched", "receipt": {"target_agent": "codex"}}
    for invalid in (internal, wrong_path, wrong_agent, {"status": "import-outcome-unknown"}):
        try:
            validate_duplicate(invalid, target)
        except AssertionError:
            continue
        raise AssertionError("Invalid duplicate outcome accepted")


def verify(case):
    case = Path(case).resolve()
    result = json.loads((case / "result.json").read_text())
    plan = json.loads((case / "plan.json").read_text())
    launch = plan["launch_request"]
    target = Path(launch["target_path"])
    assert target.is_relative_to(case / "claude")
    assert launch["target_agent"] == result["target"] == "claude-code"
    assert launch["target_session_id"] == result["targetSessionId"]
    assert str(target) == result["targetPath"]
    assert result["first"]["status"] == "launched"
    assert result["first"]["receipt"]["target_agent"] == "claude-code"
    validate_duplicate(result["duplicate"], target)
    assert result["reopen"]["target_agent"] == "claude-code"
    change, = [item for item in plan["change_set"]["changes"] if item["target"] == str(target)]
    assert target.read_bytes() == change["after"].encode()
    rows = [json.loads(line) for line in change["after"].splitlines()]
    assert all(row["sessionId"] == launch["target_session_id"] for row in rows)
    messages = [row for row in rows if row["type"] in ("user", "assistant")]
    assert len(messages) == 3 and messages[0]["type"] == "user"
    assert [(row["message"]["role"], "\n".join(block["text"] for block in row["message"]["content"]))
            for row in messages[1:]] == [
        ("user", f'Remember marker {result["marker"]}; project decision: {result["decision"]}.'),
        ("assistant", f'Confirmed {result["marker"]} and {result["decision"]}.'),
    ]
    assert list((case / "claude/projects").rglob("*.jsonl")) == [target]
    assert all(hashlib.sha256(Path(path).read_bytes()).hexdigest() == digest
               for path, digest in result["sourceFiles"].items())
    assert result["modelRequests"] == 0 and result["nativeUiVerified"] is False
    return {"duplicateOutcomeVerified": True, "sourceAndFullPayloadVerified": True,
            "targetIdentityAndCountVerified": True, "nativeUiVerified": False,
            "modelRequests": 0, "negativeCases": 4}


if __name__ == "__main__":
    self_test()
    print(json.dumps(verify(sys.argv[1]) if len(sys.argv) > 1 else {"negativeCases": 4, "passed": True}))
