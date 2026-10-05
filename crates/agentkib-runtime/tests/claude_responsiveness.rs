//! Exercises the production stdio/worker boundary with an isolated, non-model CLI.
#![cfg(target_os = "macos")]

use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use agentkib_store::Store;
use base64::Engine;
use serde_json::{Value, json};

struct Runtime {
    child: Child,
    input: Option<ChildStdin>,
    responses: Receiver<Value>,
    pending: BTreeMap<u64, Value>,
}
impl Runtime {
    fn send(&mut self, id: u64, method: &str, params: Value) {
        writeln!(
            self.input.as_mut().unwrap(),
            "{}",
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
        )
        .unwrap();
    }
    fn receive(&mut self, id: u64, timeout: Duration) -> Value {
        if let Some(response) = self.pending.remove(&id) {
            return response;
        }
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let response = self
                .responses
                .recv_timeout(remaining)
                .expect("bounded Runtime response");
            let response_id = response["id"].as_u64().expect("RPC response identity");
            if response_id == id {
                return response;
            }
            assert!(
                self.pending.insert(response_id, response).is_none(),
                "duplicate RPC response"
            );
        }
    }
    fn info_within_one_second(&mut self, id: u64) {
        let start = Instant::now();
        self.send(id, "runtime.info", json!({}));
        let response = self.receive(id, Duration::from_secs(1));
        assert!(response.get("error").is_none(), "{response}");
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        self.input.take();
        // The fixture socket's peer is dropped first on failure, releasing either
        // CLI latch. Bound cleanup independently of assertions in the test body.
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.child.try_wait().ok().flatten().is_none() {
            if Instant::now() >= deadline {
                let _ = self.child.kill();
                break;
            }
            std::thread::yield_now();
        }
        let _ = self.child.wait();
    }
}
fn gate(receiver: &Receiver<UnixStream>, phase: u8) -> UnixStream {
    let mut connection = receiver
        .recv_timeout(Duration::from_secs(5))
        .expect("CLI reached latch");
    connection
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut actual = [0];
    connection.read_exact(&mut actual).unwrap();
    assert_eq!(actual[0], phase);
    connection
}

#[test]
fn slow_cli_start_and_blocked_input_do_not_block_runtime_or_admit_a_second_send() {
    let root = tempfile::tempdir_in("/private/tmp").unwrap();
    let data = root.path().join("data");
    let claude = root.path().join("claude");
    let bin = root.path().join("bin");
    let project = root.path().join("project");
    for path in [&data, &claude, &bin, &project] {
        fs::create_dir_all(path).unwrap();
    }
    let workspace = Store::open(&data.join("agentkib.db"))
        .unwrap()
        .add_workspace(&project)
        .unwrap();
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    fs::write(
        data.join("preferences.json"),
        json!({"mcp_network":{"port":port,"lan_enabled":false,"lan_risk_accepted":false}})
            .to_string(),
    )
    .unwrap();
    let listener = UnixListener::bind(root.path().join("g")).unwrap();
    let (gate_tx, gates) = mpsc::channel();
    std::thread::spawn(move || {
        // Exactly one blocked version probe and one native reader are expected.
        for _ in 0..2 {
            let Ok((stream, _)) = listener.accept() else {
                return;
            };
            if gate_tx.send(stream).is_err() {
                return;
            }
        }
    });
    fs::write(bin.join("claude"), r#"#!/usr/bin/python3
import sys,json,pathlib,socket,select
root=pathlib.Path(__file__).parent.parent
def latch(phase):
 connection=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
 connection.connect(str(root/'g'))
 connection.sendall(phase)
 connection.recv(1)
 connection.close()
if '--version' in sys.argv:
 if (root/'gate-version').exists(): latch(b'V')
 print('2.1.285 (Claude Code)',flush=True)
 sys.exit(0)
with (root/'starts').open('a') as log: log.write('start\n')
# Read exactly initialize, without buffered read-ahead of the user frame.
line=bytearray()
while not line.endswith(b'\n'):
 byte=sys.stdin.buffer.raw.read(1)
 if not byte: sys.exit(1)
 line.extend(byte)
request=json.loads(line)
print(json.dumps({'type':'control_response','response':{'subtype':'success','request_id':request['request_id']}}),flush=True)
# The parent is writing a >5 MiB user frame. Do not consume any of it;
# a ready stdin plus this closed latch holds the native reader under backpressure.
if not select.select([sys.stdin.buffer.raw],[],[],5)[0]: sys.exit(2)
latch(b'P')
# No model, tools, result or user message is processed by this fixture.
sys.exit(0)
"#).unwrap();
    fs::set_permissions(bin.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_agentkib-runtime"))
        .env("AGENTKIB_BENCHMARK_DATA_DIR", &data)
        .env("CLAUDE_CONFIG_DIR", &claude)
        .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let input = child.stdin.take();
    let stdout = child.stdout.take().unwrap();
    let (tx, responses) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { return };
            let Ok(response) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if tx.send(response).is_err() {
                return;
            }
        }
    });
    let mut runtime = Runtime {
        child,
        input,
        responses,
        pending: BTreeMap::new(),
    };
    runtime.send(1,"agentkib.handshake",json!({"protocolVersion":agentkib_protocol::PROTOCOL_VERSION,"client":{"name":"claude-responsiveness-fixture","version":"0"}}));
    assert!(
        runtime
            .receive(1, Duration::from_secs(5))
            .get("error")
            .is_none()
    );
    runtime.send(2, "runtime.info", json!({}));
    assert!(
        runtime
            .receive(2, Duration::from_secs(5))
            .get("error")
            .is_none()
    );
    runtime.send(3,"claude.managed",json!({"operation":"create","workspaceId":workspace.id,"requestId":uuid::Uuid::new_v4().to_string(),"deviceId":"fixture"}));
    let created = runtime.receive(3, Duration::from_secs(5));
    assert_eq!(created["result"]["accepted"], true, "{created}");
    let session = created["result"]["sessionId"].as_str().unwrap();
    let boot = created["result"]["runtimeBootId"].as_str().unwrap();
    fs::write(root.path().join("gate-version"), b"").unwrap();
    let request = uuid::Uuid::new_v4().to_string();
    let mut bytes = vec![0u8; 4 * 1024 * 1024];
    bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    let input = json!([{"type":"image","source":{"type":"base64","media_type":"image/png","data":base64::engine::general_purpose::STANDARD.encode(bytes)}}]);
    runtime.send(4,"web.request",json!({"operation":"send","sessionId":session,"requestId":request,"deviceId":"fixture","runtimeBootId":boot,"expectedRevision":0,"experimentalEnabled":true,"input":input}));
    let mut version_gate = gate(&gates, b'V');
    runtime.info_within_one_second(5);
    runtime.send(6,"web.request",json!({"operation":"send","sessionId":session,"requestId":uuid::Uuid::new_v4().to_string(),"deviceId":"fixture","runtimeBootId":boot,"expectedRevision":0,"experimentalEnabled":true,"text":"must not queue"}));
    assert_eq!(
        runtime.receive(6, Duration::from_secs(1))["error"]["message"],
        "web-busy"
    );
    fs::remove_file(root.path().join("gate-version")).unwrap();
    version_gate.write_all(b"x").unwrap();
    drop(version_gate);
    assert_eq!(
        runtime.receive(4, Duration::from_secs(5))["result"]["accepted"],
        true
    );
    let mut pipe_gate = gate(&gates, b'P');
    runtime.info_within_one_second(7);
    runtime.send(
        8,
        "web.request",
        json!({"operation":"live","sessionId":session,"experimentalEnabled":true}),
    );
    let live = runtime.receive(8, Duration::from_secs(1))["result"].clone();
    assert_eq!(live["status"], "running");
    runtime.send(9,"web.request",json!({"operation":"send","sessionId":session,"requestId":uuid::Uuid::new_v4().to_string(),"deviceId":"fixture","runtimeBootId":boot,"expectedRevision":live["revision"],"experimentalEnabled":true,"text":"must not dispatch"}));
    let rejected = runtime.receive(9, Duration::from_secs(1));
    assert_eq!(
        rejected["result"]["controlOutcome"], "not-dispatched",
        "{rejected}"
    );
    assert_eq!(rejected["result"]["error"], "session-busy");
    runtime.send(10,"web.request",json!({"operation":"stop","sessionId":session,"requestId":uuid::Uuid::new_v4().to_string(),"deviceId":"fixture","runtimeBootId":boot,"expectedRevision":live["revision"],"turnId":request,"experimentalEnabled":true}));
    assert_eq!(
        runtime.receive(10, Duration::from_secs(5))["result"]["accepted"],
        true
    );
    let mut eof = [0];
    assert_eq!(
        pipe_gate.read(&mut eof).unwrap(),
        0,
        "owned blocked CLI was not terminated"
    );
    assert_eq!(
        fs::read_to_string(root.path().join("starts")).unwrap(),
        "start\n"
    );
}
