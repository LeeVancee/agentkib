use super::*;
use agentkib_codex_bridge::{Bridge, Compatibility};
use std::{
    io::{Read, Write},
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
    sync::{Mutex, atomic::AtomicU64, mpsc},
    time::{Duration, Instant},
};

struct Owner {
    _directory: tempfile::TempDir,
    native: String,
    revision: Arc<AtomicU64>,
    writer: Arc<Mutex<UnixStream>>,
    unfollowed: mpsc::Receiver<()>,
    worker: std::thread::JoinHandle<()>,
}

fn read(socket: &mut UnixStream) -> Option<Value> {
    let mut header = [0; 4];
    socket.read_exact(&mut header).ok()?;
    let mut bytes = vec![0; u32::from_le_bytes(header) as usize];
    socket.read_exact(&mut bytes).unwrap();
    Some(serde_json::from_slice(&bytes).unwrap())
}

fn write(socket: &mut UnixStream, value: Value) {
    let bytes = serde_json::to_vec(&value).unwrap();
    socket
        .write_all(&(bytes.len() as u32).to_le_bytes())
        .unwrap();
    socket.write_all(&bytes).unwrap();
}

fn snapshot(native: &str, revision: u64) -> Value {
    json!({"type":"broadcast","sourceClientId":"owner","version":11,
        "method":"thread-stream-state-changed","params":{"hostId":"local",
        "conversationId":native,"change":{"type":"snapshot","revision":revision,
        "conversationState":{"id":native,"hostId":"local","title":format!("revision-{revision}"),
        "threadRuntimeStatus":{"type":"idle"},"turns":[],"requests":[]}}}})
}

impl Owner {
    fn attach(service: &mut Service, session: &str, index: usize) -> Self {
        let directory = tempfile::tempdir().unwrap();
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = directory.path().canonicalize().unwrap().join("ipc.sock");
        let listener = UnixListener::bind(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let native = format!("00000000-0000-4000-8000-{index:012}");
        let server_native = native.clone();
        let revision = Arc::new(AtomicU64::new(1));
        let server_revision = revision.clone();
        let (writer_ready, writer_receiver) = mpsc::channel();
        let (unfollow, unfollowed) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let (mut reader, _) = listener.accept().unwrap();
            reader
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let writer = Arc::new(Mutex::new(reader.try_clone().unwrap()));
            writer_ready.send(writer.clone()).unwrap();
            while let Some(request) = read(&mut reader) {
                let reply = match request["method"].as_str().unwrap() {
                    "initialize" => json!({"type":"response","requestId":request["requestId"],
                        "resultType":"success","method":"initialize","handledByClientId":"follower",
                        "result":{"clientId":"follower"}}),
                    "thread-owner-discovery" => {
                        json!({"type":"response","requestId":request["requestId"],
                        "resultType":"success","handledByClientId":"owner"})
                    }
                    "thread-stream-following-changed" => {
                        if request["params"]["following"] == false {
                            let _ = unfollow.send(());
                            return;
                        }
                        snapshot(&server_native, server_revision.load(Ordering::Acquire))
                    }
                    method => panic!("unexpected fixture request: {method}"),
                };
                write(&mut writer.lock().unwrap(), reply);
            }
        });
        let mut bridge = Bridge::connect(&path, Compatibility::default()).unwrap();
        bridge.select(&native).unwrap();
        let publisher = service
            .streams
            .as_ref()
            .unwrap()
            .publisher(session, "codex-follower");
        service.bridges.insert(
            session.into(),
            Arc::new(crate::follower_stream::ObservedBridge::new(
                bridge,
                Some(publisher),
            )),
        );
        service.recency.push(session.into());
        Self {
            _directory: directory,
            native,
            revision,
            writer: writer_receiver.recv().unwrap(),
            unfollowed,
            worker,
        }
    }

    fn push(&self) {
        let revision = self.revision.fetch_add(1, Ordering::AcqRel) + 1;
        write(
            &mut self.writer.lock().unwrap(),
            snapshot(&self.native, revision),
        );
    }
}

#[test]
fn active_subscriptions_keep_followers_until_the_last_unsubscribe() {
    let (published, events) = mpsc::channel();
    let hub =
        crate::session_stream::Hub::new("boot".into(), move |event| published.send(event).is_ok());
    let mut service = Service {
        streams: Some(hub.clone()),
        ..Service::default()
    };
    let mut owners = Vec::new();
    let mut subscriptions = Vec::new();
    // A catalog subscription must not pin every session in the cache.
    hub.subscribe("", None).unwrap();
    for index in 0..8 {
        let session = format!("indexed-{index}");
        service.reserve_follower_bridge(&session).unwrap();
        owners.push(Owner::attach(&mut service, &session, index));
        subscriptions.push(
            service
                .finish_subscription(&session, None, json!({"executionMode":"codex-follower"}))
                .unwrap(),
        );
    }
    let second_observer = service
        .finish_subscription("indexed-0", None, json!({"executionMode":"codex-follower"}))
        .unwrap();
    // Existing observers can reconnect when the native cache is full.
    service.reserve_follower_bridge("indexed-0").unwrap();
    assert_eq!(
        service
            .reserve_follower_bridge("ninth")
            .unwrap_err()
            .to_string(),
        "live-session-busy"
    );
    let busy = json!({"status":"unsupported","reason":"live-session-busy"});
    assert_eq!(
        service
            .finish_subscription("ninth", None, busy.clone())
            .unwrap_err()
            .to_string(),
        "live-session-busy"
    );
    assert!(!hub.contains("ninth"));
    // An older projection must not turn the same rejection into a valid stream.
    hub.publisher("ninth", "codex-follower")
        .observe(json!({"status":"idle"}));
    assert!(service.finish_subscription("ninth", None, busy).is_err());
    assert!(!hub.has_subscribers("ninth"));

    service
        .unsubscribe(json!({"subscriptionId":subscriptions[1]["subscriptionId"]}))
        .unwrap();
    service.reserve_follower_bridge("ninth").unwrap();
    owners[1]
        .unfollowed
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    assert!(owners[0].unfollowed.try_recv().is_err());
    assert!(service.bridges.contains_key("indexed-0"));
    assert!(!service.bridges.contains_key("indexed-1"));
    owners.push(Owner::attach(&mut service, "ninth", 8));
    service
        .finish_subscription("ninth", None, json!({"executionMode":"codex-follower"}))
        .unwrap();

    owners[0].push();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let event = events
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap();
        if event["subscriptionId"] == subscriptions[0]["subscriptionId"]
            && event["type"] == "state"
            && event["payload"]["revision"] == 2
        {
            break;
        }
    }
    service
        .unsubscribe(json!({"subscriptionId":subscriptions[0]["subscriptionId"]}))
        .unwrap();
    assert!(hub.has_subscribers("indexed-0"));
    assert!(service.reserve_follower_bridge("tenth").is_err());
    service
        .unsubscribe(json!({"subscriptionId":second_observer["subscriptionId"]}))
        .unwrap();
    assert!(!hub.has_subscribers("indexed-0"));
    service.reserve_follower_bridge("tenth").unwrap();
    owners[0]
        .unfollowed
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    assert!(!service.bridges.contains_key("indexed-0"));
    drop(service);
    for owner in owners {
        owner.worker.join().unwrap();
    }
}

#[test]
fn unsupported_read_only_subscriptions_remain_available() {
    let mut service = Service {
        streams: Some(crate::session_stream::Hub::new("boot".into(), |_| true)),
        ..Service::default()
    };
    let result = service
        .finish_subscription(
            "read-only",
            None,
            json!({"status":"unsupported","reason":"provider-unsupported"}),
        )
        .unwrap();
    assert!(result["subscriptionId"].is_string());
    assert_eq!(
        result["events"][0]["payload"]["live"]["reason"],
        "provider-unsupported"
    );
}
