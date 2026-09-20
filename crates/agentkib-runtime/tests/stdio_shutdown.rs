use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

#[test]
fn stdin_eof_flushes_every_accepted_skill_response_once() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_agentkib-runtime"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start Runtime");

    let mut stdin = child.stdin.take().expect("Runtime stdin");
    for id in 1..=3 {
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "skills.listInstalled",
            "params": {}
        });
        writeln!(stdin, "{request}").expect("send Skill request");
    }
    drop(stdin);

    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait().expect("poll Runtime exit").is_none() {
        if Instant::now() >= deadline {
            child.kill().expect("stop stalled Runtime");
            child.wait().expect("reap stalled Runtime");
            panic!("Runtime did not exit after stdin EOF");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child
        .wait_with_output()
        .expect("wait for Runtime after EOF");
    assert!(
        output.status.success(),
        "Runtime failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut responses = output
        .stdout
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_slice::<Value>(line).expect("JSON-RPC response"))
        .collect::<Vec<_>>();
    responses.sort_by_key(|response| response["id"].as_u64().expect("response id"));
    assert_eq!(responses.len(), 3);
    for (index, response) in responses.iter().enumerate() {
        assert_eq!(response["id"], index + 1);
        assert_eq!(response["error"]["code"], -32000);
    }
}
