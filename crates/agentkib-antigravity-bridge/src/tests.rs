use std::{path::Path, time::Duration};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, ReadHalf, WriteHalf};

use crate::{Client, Compatibility, Error, Event, MAX_FRAME_BYTES, RpcId};

type TestClient = Client<ReadHalf<DuplexStream>, WriteHalf<DuplexStream>>;
struct Peer {
    reader: BufReader<ReadHalf<DuplexStream>>,
    writer: WriteHalf<DuplexStream>,
}

fn pair() -> (TestClient, Peer) {
    let (client, peer) = tokio::io::duplex(16 * 1024);
    let (reader, writer) = tokio::io::split(client);
    let (peer_reader, peer_writer) = tokio::io::split(peer);
    (
        Client::from_io(reader, writer),
        Peer {
            reader: BufReader::new(peer_reader),
            writer: peer_writer,
        },
    )
}

impl Peer {
    async fn read(&mut self) -> Value {
        let mut line = String::new();
        self.reader.read_line(&mut line).await.unwrap();
        serde_json::from_str(&line).unwrap()
    }
    async fn send(&mut self, value: Value) {
        self.writer
            .write_all(format!("{value}\n").as_bytes())
            .await
            .unwrap();
    }
    async fn reply(&mut self, id: &RpcId, result: Value) {
        self.send(json!({"jsonrpc":"2.0","id":id,"result":result}))
            .await;
    }
    async fn permission(&mut self, id: Value, session_id: &str) {
        self.send(json!({"jsonrpc":"2.0","id":id,"method":"session/request_permission","params":{
            "sessionId":session_id,"toolCall":{"toolCallId":"tool-1","rawInput":{"command":"touch file"}},
            "options":[{"optionId":"allow","name":"Allow once","kind":"allow_once"},{"optionId":"deny","name":"Reject","kind":"reject_once"}]
        }})).await;
    }
}

async fn initialized() -> (TestClient, Peer) {
    let (mut client, mut peer) = pair();
    let id = client.initialize().await.unwrap();
    let request = peer.read().await;
    assert_eq!(request["params"]["clientCapabilities"], json!({}));
    peer.reply(&id, json!({"protocolVersion":1,"agentCapabilities":{"loadSession":true,"sessionCapabilities":{"list":{},"resume":{}}}})).await;
    assert!(matches!(
        client.next_event().await.unwrap(),
        Event::Response { result: Ok(_), .. }
    ));
    (client, peer)
}

async fn active() -> (TestClient, Peer, RpcId) {
    let (mut client, mut peer) = initialized().await;
    let id = client.new_session(Path::new("/workspace")).await.unwrap();
    peer.read().await;
    peer.reply(&id, json!({"sessionId":"session-1"})).await;
    client.next_event().await.unwrap();
    let prompt = client.prompt("session-1", "edit file").await.unwrap();
    peer.read().await;
    (client, peer, prompt)
}

#[test]
fn capabilities_are_negotiated_fail_closed() {
    let absent =
        Compatibility::from_initialize(&json!({"protocolVersion":1,"agentCapabilities":{}}))
            .unwrap();
    assert_eq!(absent, Compatibility::default());
    assert!(
        Compatibility::from_initialize(&json!({"protocolVersion":2,"agentCapabilities":{}}))
            .is_err()
    );
    let malformed = Compatibility::from_initialize(&json!({"protocolVersion":1,"agentCapabilities":{"loadSession":"true","sessionCapabilities":{"list":false,"resume":null}}})).unwrap();
    assert_eq!(malformed, Compatibility::default());

    let verified = json!({
        "agentInfo":{"name":"antigravity-acp","version":"agy_acp_server_1.1.1"}
    });
    Compatibility::verify_control_identity(&verified).unwrap();
    for value in [
        json!({}),
        json!({"agentInfo":{"name":"other","version":"agy_acp_server_1.1.1"}}),
        json!({"agentInfo":{"name":"antigravity-acp","version":"agy_acp_server_1.1.2"}}),
    ] {
        assert!(Compatibility::verify_control_identity(&value).is_err());
    }
}

#[tokio::test]
async fn requests_require_handshake_and_advertised_capabilities() {
    let (mut client, mut peer) = pair();
    assert!(client.list_sessions(None, None).await.is_err());
    let id = client.initialize().await.unwrap();
    peer.read().await;
    peer.reply(&id, json!({"protocolVersion":1,"agentCapabilities":{}}))
        .await;
    client.next_event().await.unwrap();
    assert!(matches!(
        client.list_sessions(None, None).await,
        Err(Error::Unsupported("session/list"))
    ));
    assert!(matches!(
        client.load_session("native", Path::new("/workspace")).await,
        Err(Error::Unsupported("session/load"))
    ));
    assert!(client.initialize().await.is_err());
}

#[tokio::test]
async fn list_preserves_cursor_and_native_records() {
    let (mut client, mut peer) = initialized().await;
    let id = client
        .list_sessions(Some(Path::new("/workspace")), Some("page-2"))
        .await
        .unwrap();
    assert_eq!(
        peer.read().await["params"],
        json!({"cwd":"/workspace","cursor":"page-2"})
    );
    let records = json!({"sessions":[{"sessionId":"native","cwd":"/workspace","title":"Original history"}],"nextCursor":"page-3"});
    peer.reply(&id, records.clone()).await;
    match client.next_event().await.unwrap() {
        Event::Response {
            result: Ok(value), ..
        } => assert_eq!(value, records),
        event => panic!("unexpected {event:?}"),
    }
}

#[tokio::test]
async fn load_receives_native_replay_before_response() {
    let (mut client, mut peer) = initialized().await;
    let id = client
        .load_session("native", Path::new("/workspace"))
        .await
        .unwrap();
    assert_eq!(peer.read().await["method"], "session/load");
    peer.send(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"native","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"original"}}}})).await;
    assert!(matches!(
        client.next_event().await.unwrap(),
        Event::SessionUpdate { .. }
    ));
    assert!(client.prompt("native", "continue").await.is_err());
    peer.reply(&id, Value::Null).await;
    client.next_event().await.unwrap();
    client.prompt("native", "continue").await.unwrap();
    assert_eq!(peer.read().await["params"]["prompt"][0]["text"], "continue");
}

#[tokio::test]
async fn permission_requires_exact_explicit_choice_during_prompt() {
    let (mut client, mut peer, prompt) = active().await;
    peer.permission(json!("request-1"), "session-1").await;
    let id = match client.next_event().await.unwrap() {
        Event::Permission { id, .. } => id,
        event => panic!("unexpected {event:?}"),
    };
    assert!(
        client
            .respond_permission(&id, Some("allow-always"))
            .await
            .is_err()
    );
    client.respond_permission(&id, Some("deny")).await.unwrap();
    assert_eq!(
        peer.read().await["result"]["outcome"],
        json!({"outcome":"selected","optionId":"deny"})
    );
    assert!(client.respond_permission(&id, Some("allow")).await.is_err());
    assert!(client.prompt("session-1", "overlap").await.is_err());
    peer.reply(&prompt, json!({"stopReason":"end_turn"})).await;
    client.next_event().await.unwrap();
    client.prompt("session-1", "next turn").await.unwrap();
}

#[tokio::test]
async fn cancellation_rejects_pending_and_late_permissions() {
    let (mut client, mut peer, prompt) = active().await;
    peer.permission(json!(77), "session-1").await;
    client.next_event().await.unwrap();
    client.cancel("session-1").await.unwrap();
    let cancel = peer.read().await;
    assert_eq!(cancel["method"], "session/cancel");
    assert!(cancel.get("id").is_none());
    assert_eq!(
        peer.read().await["result"]["outcome"]["outcome"],
        "cancelled"
    );
    assert!(
        client
            .respond_permission(&RpcId::Number(77), Some("allow"))
            .await
            .is_err()
    );
    peer.permission(json!(78), "session-1").await;
    assert!(matches!(
        client.next_event().await.unwrap(),
        Event::PermissionCancelled { .. }
    ));
    assert_eq!(
        peer.read().await["result"]["outcome"]["outcome"],
        "cancelled"
    );
    peer.reply(&prompt, json!({"stopReason":"cancelled"})).await;
    client.next_event().await.unwrap();
    assert!(client.cancel("session-1").await.is_err());
}

#[tokio::test]
async fn unrelated_server_request_never_executes_client_tools() {
    let (mut client, mut peer) = initialized().await;
    peer.send(json!({"jsonrpc":"2.0","id":1,"method":"fs/write_text_file","params":{"path":"/tmp/private","content":"bad"}})).await;
    assert!(matches!(
        client.next_event().await.unwrap(),
        Event::UnsupportedRequest { .. }
    ));
    assert_eq!(peer.read().await["error"]["code"], -32601);
}

#[tokio::test]
async fn remote_errors_do_not_attach_sessions() {
    let (mut client, mut peer) = initialized().await;
    let id = client
        .resume_session("missing", Path::new("/workspace"))
        .await
        .unwrap();
    peer.read().await;
    peer.send(
        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32002,"message":"Session not found"}}),
    )
    .await;
    assert!(matches!(
        client.next_event().await.unwrap(),
        Event::Response { result: Err(_), .. }
    ));
    assert!(client.prompt("missing", "hello").await.is_err());
    assert!(client.list_sessions(None, None).await.is_ok());
}

#[tokio::test]
async fn partial_frame_survives_cancelled_read() {
    let (mut client, mut peer) = initialized().await;
    peer.writer
        .write_all(b"{\"jsonrpc\":\"2.0\",")
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(10), client.next_event())
            .await
            .is_err()
    );
    peer.writer
        .write_all(b"\"method\":\"future/notification\",\"params\":{}}\n")
        .await
        .unwrap();
    assert!(matches!(
        client.next_event().await.unwrap(),
        Event::Notification { .. }
    ));
}

#[tokio::test]
async fn malformed_or_unsolicited_responses_close_connection() {
    let (mut client, mut peer) = initialized().await;
    peer.send(json!({"jsonrpc":"2.0","id":999,"result":{}}))
        .await;
    assert!(client.next_event().await.is_err());
    assert!(matches!(
        client.list_sessions(None, None).await,
        Err(Error::Closed)
    ));
}

#[tokio::test]
async fn overlong_frames_fail_before_unbounded_allocation() {
    let (mut client, mut peer) = initialized().await;
    let sender = tokio::spawn(async move {
        let _ = peer
            .writer
            .write_all(&vec![b'x'; MAX_FRAME_BYTES + 1])
            .await;
    });
    assert!(matches!(
        client.next_event().await,
        Err(Error::Protocol("frame exceeds limit"))
    ));
    sender.abort();
}

#[tokio::test]
async fn spawn_requires_explicit_absolute_paths() {
    assert!(crate::StdioClient::spawn(Path::new("agy"), &[], Path::new("/workspace")).is_err());
}

#[cfg(unix)]
#[test]
fn blocking_worker_keeps_reading_while_ui_answers_permission() {
    use crate::BlockingClient;
    use std::ffi::OsString;

    let script = r#"
read -r initialize
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{}}}'
read -r create
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"native"}}'
read -r prompt
printf '%s\n' '{"jsonrpc":"2.0","id":"permission","method":"session/request_permission","params":{"sessionId":"native","toolCall":{"toolCallId":"call"},"options":[{"optionId":"deny","kind":"reject_once","name":"Reject"}]}}'
read -r permission
printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
read -r hold
"#;
    let client = BlockingClient::spawn(
        Path::new("/bin/sh"),
        &[OsString::from("-c"), OsString::from(script)],
        Path::new("/"),
        Duration::from_secs(2),
    )
    .unwrap();
    assert_eq!(client.initialize().unwrap(), RpcId::Number(1));
    assert!(matches!(
        client.next_event(Duration::from_secs(2)).unwrap(),
        Some(Event::Response { result: Ok(_), .. })
    ));
    client.new_session(Path::new("/")).unwrap();
    client.next_event(Duration::from_secs(2)).unwrap().unwrap();
    let prompt = client.prompt("native", "edit").unwrap();
    let id = match client.next_event(Duration::from_secs(2)).unwrap().unwrap() {
        Event::Permission { id, .. } => id,
        event => panic!("unexpected {event:?}"),
    };
    let command_handle = client.clone();
    std::thread::spawn(move || command_handle.respond_permission(&id, Some("deny")))
        .join()
        .unwrap()
        .unwrap();
    match client.next_event(Duration::from_secs(2)).unwrap().unwrap() {
        Event::Response {
            id,
            result: Ok(result),
            ..
        } => {
            assert_eq!(id, prompt);
            assert_eq!(result["stopReason"], "end_turn");
        }
        event => panic!("unexpected {event:?}"),
    }
    client.shutdown().unwrap();
}

#[cfg(unix)]
#[test]
fn blocking_worker_no_event_is_not_success_or_completion() {
    use crate::BlockingClient;
    use std::ffi::OsString;

    let client = BlockingClient::spawn(
        Path::new("/bin/sh"),
        &[
            OsString::from("-c"),
            OsString::from("read -r initialize; read -r hold"),
        ],
        Path::new("/"),
        Duration::from_secs(2),
    )
    .unwrap();
    client.initialize().unwrap();
    assert!(
        client
            .next_event(Duration::from_millis(10))
            .unwrap()
            .is_none()
    );
    assert!(client.new_session(Path::new("/")).is_err());
    client.shutdown().unwrap();
}
