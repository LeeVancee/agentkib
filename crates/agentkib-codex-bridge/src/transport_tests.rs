#![cfg(target_os = "macos")]
use crate::{Bridge, Compatibility, Connection, Decision, Status};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    },
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

const SESSION: &str = "00000000-0000-4000-8000-000000000001";

#[test]
fn authorization_removed_during_final_refresh_never_dispatches() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    for approval in [false, true] {
        let (_dir, path, listener) = endpoint();
        let allowed = Arc::new(AtomicBool::new(true));
        let owner_allowed = allowed.clone();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            initialize(&mut socket);
            let mut snapshots = 0;
            while let Some(message) = read(&mut socket) {
                match message["method"].as_str().unwrap() {
                    "thread-owner-discovery" => write(
                        &mut socket,
                        json!({
                        "type":"response","requestId":message["requestId"],
                        "resultType":"success","handledByClientId":"owner"}),
                    ),
                    "thread-stream-following-changed" => {
                        if message["params"]["following"] == true {
                            snapshots += 1;
                            if snapshots == 2 {
                                owner_allowed.store(false, Ordering::SeqCst);
                            }
                            write(
                                &mut socket,
                                snapshot(1, if approval { "active" } else { "idle" }),
                            );
                        }
                    }
                    _ => panic!("authorization was removed before any mutation was sent"),
                }
            }
            assert_eq!(snapshots, 2);
        });
        let mut bridge = Bridge::connect(&path, known()).unwrap();
        bridge.enable_controls().unwrap();
        bridge.select(SESSION).unwrap();
        assert!(allowed.load(Ordering::SeqCst));
        let authorize = || {
            anyhow::ensure!(allowed.load(Ordering::SeqCst), "access-revoked");
            Ok(())
        };
        let mut dispatched = false;
        let result = if approval {
            bridge.approve_at_revision_with_authorization(
                &json!(42),
                "turn-1",
                Decision::Accept,
                Some(1),
                authorize,
                || dispatched = true,
            )
        } else {
            bridge.send_text_at_revision_with_authorization(
                "synthetic hello",
                Some(1),
                authorize,
                || dispatched = true,
            )
        };
        assert!(result.unwrap_err().to_string().contains("access-revoked"));
        assert!(!dispatched);
        assert_eq!(
            bridge.state().unwrap().status(),
            if approval {
                Status::AwaitingApproval
            } else {
                Status::Idle
            }
        );
        drop(bridge);
        server.join().unwrap();
    }
}

fn endpoint() -> (tempfile::TempDir, PathBuf, UnixListener) {
    let directory = tempfile::tempdir().unwrap();
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let path = directory.path().canonicalize().unwrap().join("ipc.sock");
    let listener = UnixListener::bind(&path).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    (directory, path, listener)
}
fn read(socket: &mut UnixStream) -> Option<Value> {
    let mut size = [0; 4];
    socket.read_exact(&mut size).ok()?;
    let n = u32::from_le_bytes(size) as usize;
    assert!(n < 64 * 1024);
    let mut bytes = vec![0; n];
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
fn initialize(socket: &mut UnixStream) {
    socket
        .set_read_timeout(Some(Duration::from_secs(4)))
        .unwrap();
    let request = read(socket).unwrap();
    assert_eq!(request["params"]["clientType"], "agentkib-codex-bridge");
    assert_eq!(request["version"], 0);
    write(
        socket,
        json!({"type":"response","requestId":request["requestId"],"resultType":"success","method":"initialize","handledByClientId":"follower","result":{"clientId":"follower"}}),
    );
}
fn known() -> Compatibility {
    Compatibility::fixture()
}
fn snapshot(revision: u64, status: &str) -> Value {
    json!({"type":"broadcast","sourceClientId":"owner","version":11,"method":"thread-stream-state-changed","params":{
    "hostId":"local","conversationId":SESSION,"change":{"type":"snapshot","revision":revision,"conversationState":{
        "id":SESSION,"hostId":"local","threadRuntimeStatus":{"type":status},"turns":[{"turnId":"turn-1","status":if status=="active" {"inProgress"} else {"completed"},"items":[]}],
        "requests":if status=="active" {json!([{"id":42,"method":"item/commandExecution/requestApproval","params":{"threadId":SESSION,"turnId":"turn-1","command":"echo synthetic"}}])} else {json!([])}
    }}}})
}
fn owner(
    listener: UnixListener,
    status: &'static str,
    expected_method: Option<&'static str>,
) -> thread::JoinHandle<()> {
    owner_with_refresh(listener, status, expected_method, false)
}

fn owner_with_refresh(
    listener: UnixListener,
    status: &'static str,
    expected_method: Option<&'static str>,
    stable_refresh: bool,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        initialize(&mut socket);
        let mut revision = 0;
        let mut mutations = 0;
        while let Some(message) = read(&mut socket) {
            match message["method"].as_str().unwrap_or_default() {
                "thread-owner-discovery" => {
                    assert_eq!(message["version"], 1);
                    write(
                        &mut socket,
                        json!({"type":"response","requestId":message["requestId"],"resultType":"success","handledByClientId":"owner","result":{"supportsUntrustedAppInput":true}}),
                    );
                }
                "thread-stream-following-changed" => {
                    assert_eq!(message["targetClientIds"], json!(["owner"]));
                    if message["params"]["following"] == true {
                        if revision == 0 || !stable_refresh {
                            revision += 1;
                        }
                        write(&mut socket, snapshot(revision, status));
                    }
                }
                method if method.starts_with("thread-follower-") => {
                    assert_eq!(Some(method), expected_method);
                    assert_eq!(message["targetClientId"], "owner");
                    assert!(message.get("hostId").is_none());
                    mutations += 1;
                    assert_eq!(mutations, 1, "duplicate mutation");
                    if method == "thread-follower-start-turn" {
                        assert_eq!(
                            message["params"]["turnStart"]["request"],
                            json!({"threadId":SESSION,"input":[{"type":"text","text":"synthetic hello","text_elements":[]}]})
                        );
                    }
                    if method == "thread-follower-interrupt-turn" {
                        assert_eq!(message["version"], 4);
                        assert_eq!(
                            message["params"],
                            json!({"conversationId":SESSION,
                            "mode":"user-stop","expectedTurnId":"turn-1"})
                        );
                    }
                    if method == "thread-follower-command-approval-decision" {
                        assert_eq!(message["params"]["decision"], "accept");
                    }
                    write(
                        &mut socket,
                        json!({"type":"response","requestId":message["requestId"],"resultType":"success","method":method,"handledByClientId":"owner","result":{"ok":true,"interruptedTurnId":"turn-1"}}),
                    );
                }
                _ => panic!("unexpected operation"),
            }
        }
        assert_eq!(mutations, usize::from(expected_method.is_some()));
    })
}

#[test]
fn initializes_with_own_identity_without_scanning_sessions() {
    let (_dir, path, listener) = endpoint();
    let server = thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        initialize(&mut s);
        assert!(read(&mut s).is_none());
    });
    drop(Connection::connect(&path).unwrap());
    server.join().unwrap();
}
#[test]
fn unsafe_or_symlink_endpoints_are_rejected() {
    let (_dir, path, _listener) = endpoint();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();
    assert!(Connection::connect(&path).is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let link = path.with_file_name("link.sock");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    assert!(Connection::connect(&link).is_err());
    fs::set_permissions(path.parent().unwrap(), fs::Permissions::from_mode(0o755)).unwrap();
    assert!(Connection::connect(&path).is_err());
}
#[test]
fn oversized_frame_closes_connection() {
    let (_dir, path, listener) = endpoint();
    let server = thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        initialize(&mut s);
        s.write_all(&u32::MAX.to_le_bytes()).unwrap();
    });
    let mut client = Connection::connect(&path).unwrap();
    assert!(
        client
            .receive(Instant::now() + Duration::from_secs(1))
            .is_err()
    );
    assert!(!client.is_connected());
    server.join().unwrap();
}
#[test]
fn partial_frame_survives_poll_timeout() {
    let (_dir, path, listener) = endpoint();
    let server = thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        initialize(&mut s);
        let bytes = serde_json::to_vec(&json!({"type":"broadcast"})).unwrap();
        s.write_all(&(bytes.len() as u32).to_le_bytes()).unwrap();
        s.write_all(&bytes[..3]).unwrap();
        thread::sleep(Duration::from_millis(100));
        s.write_all(&bytes[3..]).unwrap();
    });
    let mut c = Connection::connect(&path).unwrap();
    assert!(
        c.receive(Instant::now() + Duration::from_millis(20))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        c.receive(Instant::now() + Duration::from_secs(1))
            .unwrap()
            .unwrap()["type"],
        "broadcast"
    );
    server.join().unwrap();
}
#[test]
fn unknown_versions_never_enable_controls() {
    let (_dir, path, listener) = endpoint();
    let server = owner(listener, "idle", None);
    let mut b = Bridge::connect(&path, Compatibility::default()).unwrap();
    assert!(b.enable_controls().is_err());
    b.select(SESSION).unwrap();
    assert!(b.send_text("hello").is_err());
    drop(b);
    server.join().unwrap();
}
#[test]
fn revision_changes_under_operation_lock_prevent_web_send() {
    let (_dir, path, listener) = endpoint();
    let server = owner(listener, "idle", None);
    let mut bridge = Bridge::connect(&path, known()).unwrap();
    bridge.enable_controls().unwrap();
    bridge.select(SESSION).unwrap();
    let revision = bridge.state().unwrap().revision();
    let mut dispatched = false;
    assert!(
        bridge
            .send_text_at_revision_with_dispatch("synthetic hello", revision, || dispatched = true)
            .unwrap_err()
            .to_string()
            .contains("revision changed")
    );
    assert!(!dispatched);
    assert_eq!(bridge.state().unwrap().status(), Status::Idle);
    drop(bridge);
    server.join().unwrap();
}

#[test]
fn dispatch_signal_covers_send_and_approval_owner_failures() {
    for approval in [false, true] {
        for receipt in ["reject", "wrong-method", "disconnect"] {
            let (_dir, path, listener) = endpoint();
            let server = thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                initialize(&mut socket);
                let mut mutations = 0;
                while let Some(message) = read(&mut socket) {
                    match message["method"].as_str().unwrap() {
                        "thread-owner-discovery" => write(
                            &mut socket,
                            json!({
                            "type":"response","requestId":message["requestId"],
                            "resultType":"success","handledByClientId":"owner"}),
                        ),
                        "thread-stream-following-changed"
                            if message["params"]["following"] == true =>
                        {
                            write(
                                &mut socket,
                                snapshot(1, if approval { "active" } else { "idle" }),
                            )
                        }
                        method if method.starts_with("thread-follower-") => {
                            mutations += 1;
                            assert_eq!(mutations, 1);
                            if receipt == "disconnect" {
                                break;
                            }
                            write(
                                &mut socket,
                                json!({"type":"response", "requestId":message["requestId"],
                                "resultType":if receipt == "reject" { "error" } else { "success" },
                                "method":"unexpected", "handledByClientId":"owner", "error":"request-timeout"}),
                            );
                        }
                        _ => (),
                    }
                }
                assert_eq!(mutations, 1);
            });
            let mut bridge = Bridge::connect(&path, known()).unwrap();
            bridge.enable_controls().unwrap();
            bridge.select(SESSION).unwrap();
            let mut dispatched = false;
            let result = if approval {
                bridge.approve_at_revision_with_dispatch(
                    &json!(42),
                    "turn-1",
                    Decision::Accept,
                    Some(1),
                    || dispatched = true,
                )
            } else {
                bridge.send_text_at_revision_with_dispatch("synthetic hello", Some(1), || {
                    dispatched = true
                })
            };
            assert!(result.is_err());
            assert!(dispatched, "{approval} {receipt}");
            drop(bridge);
            server.join().unwrap();
        }
    }
}

#[test]
fn oversized_mutation_frame_is_not_dispatched_or_fenced() {
    let (_dir, path, listener) = endpoint();
    let server = owner_with_refresh(listener, "idle", None, true);
    let mut bridge = Bridge::connect(&path, known()).unwrap();
    bridge.enable_controls().unwrap();
    bridge.select(SESSION).unwrap();
    let mut dispatched = false;
    // The allowed raw text expands beyond the IPC frame bound when JSON escaped.
    assert!(
        bridge
            .send_text_at_revision_with_dispatch(&"\u{1}".repeat(16384), Some(1), || dispatched =
                true)
            .is_err()
    );
    assert!(!dispatched);
    assert_eq!(bridge.state().unwrap().status(), Status::Idle);
    drop(bridge);
    server.join().unwrap();
}

#[test]
fn approval_revision_change_does_not_dispatch() {
    let (_dir, path, listener) = endpoint();
    let server = owner(listener, "active", None);
    let mut bridge = Bridge::connect(&path, known()).unwrap();
    bridge.enable_controls().unwrap();
    bridge.select(SESSION).unwrap();
    let mut dispatched = false;
    assert!(
        bridge
            .approve_at_revision_with_dispatch(
                &json!(42),
                "turn-1",
                Decision::Accept,
                Some(1),
                || dispatched = true
            )
            .is_err()
    );
    assert!(!dispatched);
    assert_eq!(bridge.state().unwrap().status(), Status::AwaitingApproval);
    drop(bridge);
    server.join().unwrap();
}

#[test]
fn unchanged_owner_refresh_keeps_revision_and_allows_one_guarded_send() {
    let (_dir, path, listener) = endpoint();
    let server = owner_with_refresh(listener, "idle", Some("thread-follower-start-turn"), true);
    let mut bridge = Bridge::connect(&path, known()).unwrap();
    bridge.enable_controls().unwrap();
    bridge.select(SESSION).unwrap();
    let revision = bridge.state().unwrap().revision();
    for _ in 0..3 {
        bridge.refresh().unwrap();
        assert_eq!(bridge.state().unwrap().revision(), revision);
    }
    let mut dispatches = 0;
    bridge
        .send_text_at_revision_with_dispatch("synthetic hello", revision, || dispatches += 1)
        .unwrap();
    assert_eq!(dispatches, 1);
    bridge.refresh().unwrap();
    assert_eq!(bridge.state().unwrap().status(), Status::OutcomeUnknown);
    assert!(bridge.send_text_at_revision("duplicate", revision).is_err());
    drop(bridge);
    server.join().unwrap();
}

#[test]
fn refresh_observes_owner_change_and_discovery_time_patches_before_send() {
    for change_owner in [true, false] {
        let (_dir, path, listener) = endpoint();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            initialize(&mut socket);
            let mut discoveries = 0;
            while let Some(message) = read(&mut socket) {
                match message["method"].as_str().unwrap_or_default() {
                    "thread-owner-discovery" => {
                        discoveries += 1;
                        if discoveries == 2 && !change_owner {
                            write(
                                &mut socket,
                                json!({"type":"broadcast","sourceClientId":"owner",
                                "version":11,"method":"thread-stream-state-changed","params":{
                                "hostId":"local","conversationId":SESSION,"change":{
                                "type":"patches","baseRevision":1,"revision":2,"patches":[{
                                "op":"replace","path":["threadRuntimeStatus","type"],"value":"active"}, {
                                "op":"replace","path":["turns",0,"status"],"value":"inProgress"}]}}}),
                            );
                        }
                        write(
                            &mut socket,
                            json!({"type":"response","requestId":message["requestId"],
                            "resultType":"success","handledByClientId":if discoveries>1 && change_owner {"other-owner"} else {"owner"},
                            "result":{}}),
                        );
                    }
                    "thread-stream-following-changed" => {
                        if message["params"]["following"] == true {
                            let mut value = snapshot(if discoveries > 1 { 2 } else { 1 }, "idle");
                            if discoveries > 1 {
                                value["params"]["change"]["conversationState"]["threadRuntimeStatus"]
                                    ["type"] = json!("active");
                                value["params"]["change"]["conversationState"]["turns"][0]["status"] =
                                    json!("inProgress");
                            }
                            write(&mut socket, value);
                        }
                    }
                    _ => panic!("changed owner/state must not receive a mutation"),
                }
            }
        });
        let mut bridge = Bridge::connect(&path, known()).unwrap();
        bridge.enable_controls().unwrap();
        bridge.select(SESSION).unwrap();
        let revision = bridge.state().unwrap().revision();
        let error = bridge
            .send_text_at_revision("synthetic hello", revision)
            .unwrap_err();
        if change_owner {
            assert!(error.to_string().contains("owner changed"));
            assert_eq!(bridge.state().unwrap().status(), Status::Unsupported);
            assert!(bridge.state().unwrap().revision().is_none());
        } else {
            assert!(error.to_string().contains("revision changed"));
            assert_eq!(bridge.state().unwrap().status(), Status::Running);
        }
        drop(bridge);
        server.join().unwrap();
    }
}

#[test]
fn send_is_targeted_and_cannot_be_repeated_without_sync() {
    let (_dir, path, listener) = endpoint();
    let server = owner(listener, "idle", Some("thread-follower-start-turn"));
    let mut b = Bridge::connect(&path, known()).unwrap();
    b.enable_controls().unwrap();
    b.select(SESSION).unwrap();
    b.send_text("synthetic hello").unwrap();
    assert_eq!(b.state().unwrap().status(), Status::OutcomeUnknown);
    assert!(b.send_text("duplicate").is_err());
    drop(b);
    server.join().unwrap();
}
#[test]
fn running_session_rejects_send_and_old_turn_stop() {
    let (_dir, path, listener) = endpoint();
    let server = owner(listener, "active", None);
    let mut b = Bridge::connect(&path, known()).unwrap();
    b.enable_controls().unwrap();
    b.select(SESSION).unwrap();
    assert!(b.send_text("hello").is_err());
    assert!(b.stop("old-turn").is_err());
    drop(b);
    server.join().unwrap();
}
#[test]
fn stop_binds_the_current_turn() {
    let (_dir, path, listener) = endpoint();
    let server = owner(listener, "active", Some("thread-follower-interrupt-turn"));
    let mut b = Bridge::connect(&path, known()).unwrap();
    b.enable_controls().unwrap();
    b.select(SESSION).unwrap();
    b.stop("turn-1").unwrap();
    assert_eq!(b.state().unwrap().status(), Status::OutcomeUnknown);
    assert!(b.stop("turn-1").is_err());
    drop(b);
    server.join().unwrap();
}

#[test]
fn idle_session_rejects_stop_without_sending() {
    let (_dir, path, listener) = endpoint();
    let server = owner(listener, "idle", None);
    let mut b = Bridge::connect(&path, known()).unwrap();
    b.enable_controls().unwrap();
    b.select(SESSION).unwrap();
    assert!(b.stop("turn-1").is_err());
    assert!(b.stop("").is_err());
    drop(b);
    server.join().unwrap();
}
#[test]
fn approvals_bind_pending_request_and_turn() {
    let (_dir, path, listener) = endpoint();
    let server = owner(
        listener,
        "active",
        Some("thread-follower-command-approval-decision"),
    );
    let mut b = Bridge::connect(&path, known()).unwrap();
    b.enable_controls().unwrap();
    b.select(SESSION).unwrap();
    assert!(b.approve(&json!(41), "turn-1", Decision::Accept).is_err());
    assert!(b.approve(&json!(42), "old-turn", Decision::Accept).is_err());
    b.approve(&json!(42), "turn-1", Decision::Accept).unwrap();
    assert!(b.approve(&json!(42), "turn-1", Decision::Accept).is_err());
    drop(b);
    server.join().unwrap();
}

fn restricted_approval_owner(
    listener: UnixListener,
    remove_on_refresh: bool,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        initialize(&mut socket);
        let mut revision = 0;
        let mut mutations = 0;
        while let Some(message) = read(&mut socket) {
            match message["method"].as_str().unwrap_or_default() {
                "thread-owner-discovery" => write(
                    &mut socket,
                    json!({"type":"response","requestId":message["requestId"],"resultType":"success","handledByClientId":"owner","result":{"supportsUntrustedAppInput":true}}),
                ),
                "thread-stream-following-changed" => {
                    assert_eq!(message["targetClientIds"], json!(["owner"]));
                    if message["params"]["following"] == true {
                        revision += 1;
                        let mut state = snapshot(revision, "active");
                        let requests =
                            &mut state["params"]["change"]["conversationState"]["requests"];
                        if remove_on_refresh && revision > 1 {
                            *requests = json!([]);
                        } else {
                            requests[0]["params"]["availableDecisions"] =
                                json!(["accept", "cancel"]);
                        }
                        write(&mut socket, state);
                    }
                }
                "thread-follower-command-approval-decision" => {
                    assert!(!remove_on_refresh, "stale approval must send no mutation");
                    mutations += 1;
                    assert_eq!(mutations, 1, "unoffered decline must send no mutation");
                    assert_eq!(message["targetClientId"], "owner");
                    assert_eq!(
                        message["params"],
                        json!({"conversationId":SESSION,"requestId":42,"decision":"cancel"})
                    );
                    write(
                        &mut socket,
                        json!({"type":"response","requestId":message["requestId"],"resultType":"success","method":"thread-follower-command-approval-decision","handledByClientId":"owner","result":{"ok":true}}),
                    );
                }
                _ => panic!("unexpected operation: {}", message["method"]),
            }
        }
        assert_eq!(mutations, usize::from(!remove_on_refresh));
        assert_eq!(revision, if remove_on_refresh { 2 } else { 3 });
    })
}

#[test]
fn approval_rejects_unoffered_decline_and_sends_exact_cancel() {
    let (_dir, path, listener) = endpoint();
    let server = restricted_approval_owner(listener, false);
    let mut b = Bridge::connect(&path, known()).unwrap();
    b.enable_controls().unwrap();
    b.select(SESSION).unwrap();
    let error = b
        .approve(&json!(42), "turn-1", Decision::Decline)
        .unwrap_err();
    assert!(error.to_string().contains("decision not offered by owner"));
    assert_eq!(b.state().unwrap().status(), Status::AwaitingApproval);
    b.approve(&json!(42), "turn-1", Decision::Cancel).unwrap();
    assert_eq!(b.state().unwrap().status(), Status::OutcomeUnknown);
    drop(b);
    server.join().unwrap();
}

#[test]
fn approval_removed_during_refresh_sends_no_mutation() {
    let (_dir, path, listener) = endpoint();
    let server = restricted_approval_owner(listener, true);
    let mut b = Bridge::connect(&path, known()).unwrap();
    b.enable_controls().unwrap();
    b.select(SESSION).unwrap();
    assert_eq!(b.state().unwrap().approvals().len(), 1);
    let mut dispatched = false;
    let error = b
        .approve_at_revision_with_dispatch(&json!(42), "turn-1", Decision::Accept, None, || {
            dispatched = true
        })
        .unwrap_err();
    assert!(!dispatched);
    assert!(error.to_string().contains("approval no longer pending"));
    assert!(b.state().unwrap().approvals().is_empty());
    assert_eq!(b.state().unwrap().status(), Status::Running);
    drop(b);
    server.join().unwrap();
}

#[test]
fn mismatched_owner_response_is_rejected() {
    let (_dir, path, listener) = endpoint();
    let server = thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        initialize(&mut s);
        let r = read(&mut s).unwrap();
        write(
            &mut s,
            json!({"type":"response","requestId":r["requestId"],"resultType":"success","handledByClientId":"other-owner","result":{}}),
        );
    });
    let mut c = Connection::connect(&path).unwrap();
    assert!(
        c.request(
            "thread-owner-discovery",
            json!({"conversationId":SESSION,"hostId":"local"}),
            Some("owner"),
            |_| Ok(())
        )
        .is_err()
    );
    server.join().unwrap();
}

#[test]
fn timeout_discards_connection_and_never_retries() {
    let (_dir, path, listener) = endpoint();
    let server = thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        initialize(&mut s);
        assert!(read(&mut s).is_some());
        assert!(read(&mut s).is_none(), "no duplicate request after timeout");
    });
    let mut c = Connection::connect(&path).unwrap();
    assert!(
        c.request(
            "thread-follower-start-turn",
            json!({"conversationId":SESSION}),
            Some("owner"),
            |_| Ok(())
        )
        .is_err()
    );
    assert!(!c.is_connected());
    server.join().unwrap();
}

#[test]
fn never_claims_ownership_during_discovery() {
    let (_dir, path, listener) = endpoint();
    let server = thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        initialize(&mut s);
        write(
            &mut s,
            json!({"type":"client-discovery-request","requestId":"discovery","request":{"method":"thread-owner-discovery"}}),
        );
        let response = read(&mut s).unwrap();
        assert_eq!(response["response"]["canHandle"], false);
        assert_eq!(response["requestId"], "discovery");
        write(&mut s, json!({"type":"broadcast","method":"fixture"}));
    });
    let mut c = Connection::connect(&path).unwrap();
    assert_eq!(
        c.receive(Instant::now() + Duration::from_secs(1))
            .unwrap()
            .unwrap()["method"],
        "fixture"
    );
    server.join().unwrap();
}

#[test]
fn following_status_request_is_answered_only_for_selected_owner() {
    let (_dir, path, listener) = endpoint();
    let server = thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        initialize(&mut s);
        let r = read(&mut s).unwrap();
        write(
            &mut s,
            json!({"type":"response","requestId":r["requestId"],"resultType":"success","handledByClientId":"owner","result":{}}),
        );
        assert_eq!(read(&mut s).unwrap()["params"]["following"], true);
        write(&mut s, snapshot(1, "idle"));
        for source in ["stranger", "owner"] {
            write(
                &mut s,
                json!({"type":"broadcast","method":"thread-stream-following-status-requested","version":1,"sourceClientId":source,
                "params":{"conversationId":SESSION,"hostId":"local"}}),
            );
        }
        let response = read(&mut s).unwrap();
        assert_eq!(response["params"]["following"], true);
        assert_eq!(response["targetClientIds"], json!(["owner"]));
        assert_eq!(
            read(&mut s).unwrap()["params"]["following"],
            false,
            "no extra reply to stranger"
        );
    });
    let mut b = Bridge::connect(&path, known()).unwrap();
    b.select(SESSION).unwrap();
    b.poll(Duration::from_secs(1)).unwrap();
    b.poll(Duration::from_secs(1)).unwrap();
    drop(b);
    server.join().unwrap();
}
