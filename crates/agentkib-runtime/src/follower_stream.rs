//! One socket consumer per follower. Native reads wake immediately on data;
//! the bounded wait only lets queued controls/shutdown acquire the same owner.
use crate::codex_item::{content_parts_text, item_kind};
use crate::session_stream::{MAX_ITEM_TEXT_BYTES, bounded_text};
use agentkib_codex_bridge::{Bridge, SessionState, Status};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::sync::{
    Arc, Mutex, MutexGuard,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::time::{Duration, Instant};

pub(super) struct ObservedBridge {
    bridge: Arc<Mutex<Bridge>>,
    stopped: Arc<AtomicBool>,
    waiting: Arc<AtomicUsize>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl ObservedBridge {
    pub fn new(mut bridge: Bridge, publisher: Option<crate::session_stream::Publisher>) -> Self {
        if let Some(publisher) = publisher {
            // The first native snapshot supplies activity, while the indexed
            // history reader owns already-completed transcript rows.
            let initial = bridge
                .state()
                .and_then(|state| state.turns().ok())
                .unwrap_or_default()
                .into_iter()
                .filter(|turn| {
                    turn["turnId"].as_str() != bridge.state().and_then(SessionState::active_turn)
                })
                .filter_map(|turn| turn["turnId"].as_str().map(str::to_owned))
                .collect::<BTreeSet<_>>();
            let previous = Mutex::new(
                bridge
                    .state()
                    .and_then(|state| state.turns().ok())
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|turn| turn["turnId"].as_str().map(str::to_owned))
                    .collect::<BTreeSet<_>>(),
            );
            let previous_settings = Mutex::new(serde_json::Value::Null);
            let invalidated = Mutex::new(false);
            bridge.set_observer(move |state| {
                let recovered = {
                    let mut invalidated = invalidated.lock().unwrap_or_else(|p| p.into_inner());
                    if state.revision().is_none() {
                        *invalidated = true;
                        false
                    } else {
                        std::mem::take(&mut *invalidated)
                    }
                };
                let mut removed = Vec::new();
                if let Ok(turns) = state.turns() {
                    let current = turns
                        .iter()
                        .filter_map(|turn| turn["turnId"].as_str().map(str::to_owned))
                        .collect::<BTreeSet<_>>();
                    let mut previous = previous.lock().unwrap_or_else(|p| p.into_inner());
                    if matches!(
                        state.status(),
                        Status::Idle | Status::Running | Status::AwaitingApproval
                    ) {
                        removed = previous.difference(&current).cloned().collect();
                        *previous = current;
                    }
                }
                if !recovered {
                    publisher.remove_turns(&removed);
                }
                publish(state, &publisher, &initial, recovered.then_some(removed.as_slice()));
                if let Some(snapshot) = state.snapshot() {
                    let settings = json!({"settings":snapshot["latestThreadSettings"],"model":snapshot["latestModel"],"effort":snapshot["latestReasoningEffort"],"goal":snapshot["goal"]});
                    let mut previous_settings = previous_settings.lock().unwrap_or_else(|p| p.into_inner());
                    if *previous_settings != settings || recovered {
                        publisher.invalidate(&["settings", "goal"]);
                        *previous_settings = settings;
                    }
                }
                if recovered {
                    publisher.invalidate(&["history", "catalog", "receipts"]);
                }
            });
        }
        let bridge = Arc::new(Mutex::new(bridge));
        let stopped = Arc::new(AtomicBool::new(false));
        let waiting = Arc::new(AtomicUsize::new(0));
        let reader = bridge.clone();
        let stop = stopped.clone();
        let waiters = waiting.clone();
        let worker = std::thread::spawn(move || {
            let mut retry_at = Instant::now();
            let mut retry_delay = Duration::from_millis(250);
            while !stop.load(Ordering::Acquire) {
                if waiters.load(Ordering::Acquire) != 0 {
                    std::thread::yield_now();
                    continue;
                }
                let mut bridge = reader.lock().unwrap_or_else(|p| p.into_inner());
                if bridge.needs_reconnect() {
                    if Instant::now() < retry_at {
                        drop(bridge);
                        std::thread::park_timeout(Duration::from_millis(50));
                        continue;
                    }
                    // Retry only an invalidated observation, never a model turn
                    // or a control request. Healthy streams never request snapshots.
                    if bridge.reconnect().is_err() {
                        retry_at = Instant::now() + retry_delay;
                        retry_delay = (retry_delay * 2).min(Duration::from_secs(5));
                    } else {
                        retry_delay = Duration::from_millis(250);
                        retry_at = Instant::now();
                    }
                } else if bridge.needs_mutation_confirmation() {
                    // A receipt can follow the final idle broadcast. Confirm
                    // it once instead of waiting for another event or polling
                    // snapshots periodically. Never resend the mutation.
                    let _ = bridge.refresh();
                } else {
                    let _ = bridge.poll(Duration::from_millis(50));
                }
            }
        });
        Self {
            bridge,
            stopped,
            waiting,
            worker: Some(worker),
        }
    }
    pub fn lock(&self) -> MutexGuard<'_, Bridge> {
        self.waiting.fetch_add(1, Ordering::AcqRel);
        let guard = self.bridge.lock().unwrap_or_else(|p| p.into_inner());
        self.waiting.fetch_sub(1, Ordering::AcqRel);
        guard
    }
}
impl Drop for ObservedBridge {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn publish(
    state: &SessionState,
    publisher: &crate::session_stream::Publisher,
    initial: &BTreeSet<String>,
    recovered: Option<&[String]>,
) {
    let questions = state.questions();
    let status = if questions.is_empty() {
        json!(state.status())
    } else {
        json!("waiting-input")
    };
    let approvals = state
        .approvals()
        .into_iter()
        .map(|approval| crate::web::safe_approval(approval, true))
        .collect::<Vec<_>>();
    let turn_id = state.active_turn();
    let mut text = String::new();
    let native_turns = state.turns();
    let valid_history = native_turns.is_ok() && state.snapshot().is_some();
    let turns = native_turns.unwrap_or_default();
    if valid_history && recovered.is_none() {
        publisher.retain_turns(
            &turns
                .iter()
                .filter_map(|turn| turn["turnId"].as_str())
                .collect::<Vec<_>>(),
        );
    }
    let live_count = state
        .snapshot()
        .and_then(|snapshot| snapshot["turns"].as_array())
        .map_or(0, Vec::len);
    let turns = recent_turns(turns, live_count, turn_id, initial);
    let mut authoritative = Vec::new();
    let mut candidates = Vec::new();
    for turn in turns {
        if let Some(id) = turn["turnId"].as_str() {
            let ids = turn["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| item_kind(item).is_some())
                .filter_map(|item| item["id"].as_str().map(str::to_owned))
                .collect();
            authoritative.push((id.to_owned(), ids));
        }
        for item in turn["items"].as_array().into_iter().flatten() {
            if item["id"].is_string() && item_kind(item).is_some() {
                candidates.push((turn, item));
            }
        }
    }
    // Bound the complete projection, not the start of each native turn. This
    // keeps the current output after long tool runs and avoids cache churn.
    let start = candidates.len().saturating_sub(100);
    let mut recovered_items = Vec::new();
    for (turn, item) in candidates.into_iter().skip(start) {
        let Some(id) = item["id"].as_str() else {
            continue;
        };
        let kind = item_kind(item).expect("supported item");
        let content = item["text"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| content_parts_text(item));
        if kind == "agent-message" && turn["turnId"].as_str() == turn_id {
            if text.len() + content.len() <= MAX_ITEM_TEXT_BYTES {
                text.push_str(&content);
            }
            if recovered.is_none() {
                publisher.item_text_with_identity(id, turn_id, &content, true);
            }
        }
        // Streaming text travels as append deltas. Only completed text and
        // tool changes need an item replacement on the live channel.
        if recovered.is_some() || kind != "agent-message" || turn["turnId"].as_str() != turn_id {
            // Completion and reconnect must preserve the same UTF-8 preview
            // as streaming. Truncated items cannot provide complete coverage.
            let (content, truncated) = bounded_text(&content);
            let projected = json!({"id":id,"kind":kind,"turn_id":turn["turnId"],"content":content,"tool_name":if kind=="tool-summary" {item["type"].clone()} else {Value::Null},"tool_status":item["status"],"attachment_count":attachment_count(item),"truncated":truncated,"ephemeral":true});
            if recovered.is_some() {
                recovered_items.push(projected);
            } else {
                publisher.item(projected);
            }
        }
    }
    let live = json!({"status":status,"revision":state.revision(),"turnId":turn_id,"streamText":text,"sendEnabled":state.status()==Status::Idle,"stopEnabled":crate::web::codex_stop_enabled(true,state.status(),turn_id),"approvals":approvals,"questions":questions});
    if let Some(removed) = recovered {
        publisher.restart(live, recovered_items, &authoritative, removed);
    } else {
        publisher.observe(live);
    }
    if valid_history && recovered.is_none() {
        publisher.authoritative_turns(&authoritative);
    }
}

fn attachment_count(item: &Value) -> usize {
    item["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|part| {
            matches!(
                part["type"].as_str(),
                Some("image" | "localImage" | "input_image" | "document" | "input_file")
            )
        })
        .count()
}

fn recent_turns<'a>(
    turns: Vec<&'a Value>,
    live_count: usize,
    active: Option<&str>,
    initial: &BTreeSet<String>,
) -> Vec<&'a Value> {
    let live_count = live_count.min(turns.len());
    let (live, history) = turns.split_at(live_count);
    let mut seen = BTreeSet::new();
    let mut ordered = Vec::new();
    // Canonical history is ordered; prefer its matching live overlay, and put
    // new live-only turns after history. The active turn must always survive.
    for turn in history.iter().chain(live) {
        let Some(id) = turn["turnId"].as_str() else {
            continue;
        };
        if (initial.contains(id) && Some(id) != active) || !seen.insert(id) {
            continue;
        }
        let turn = live
            .iter()
            .find(|live| live["turnId"] == id)
            .copied()
            .unwrap_or(turn);
        ordered.push(turn);
    }
    if let Some(index) = ordered
        .iter()
        .position(|turn| turn["turnId"].as_str() == active)
    {
        let turn = ordered.remove(index);
        ordered.push(turn);
    }
    ordered.drain(..ordered.len().saturating_sub(20));
    ordered
}

#[cfg(test)]
mod tests {
    use super::*;
    use agentkib_codex_bridge::Compatibility;
    use std::io::{Read, Write};
    use std::os::unix::{
        fs::PermissionsExt,
        net::{UnixListener, UnixStream},
    };
    use std::sync::mpsc;

    const SESSION: &str = "00000000-0000-4000-8000-000000000001";

    fn endpoint() -> (tempfile::TempDir, std::path::PathBuf, UnixListener) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = dir.path().canonicalize().unwrap().join("ipc.sock");
        let listener = UnixListener::bind(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        (dir, path, listener)
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
    fn select(socket: &mut UnixStream, owner: &str, revision: u64, snapshot: Value) {
        socket
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        for method in [
            "initialize",
            "thread-owner-discovery",
            "thread-stream-following-changed",
        ] {
            let request = read(socket).unwrap();
            assert_eq!(request["method"], method);
            match method {
                "initialize" => write(
                    socket,
                    json!({"type":"response","requestId":request["requestId"],"resultType":"success","method":"initialize","handledByClientId":"follower","result":{"clientId":"follower"}}),
                ),
                "thread-owner-discovery" => write(
                    socket,
                    json!({"type":"response","requestId":request["requestId"],"resultType":"success","handledByClientId":owner}),
                ),
                _ => write(
                    socket,
                    json!({"type":"broadcast","sourceClientId":owner,"version":11,"method":"thread-stream-state-changed","params":{"hostId":"local","conversationId":SESSION,"change":{"type":"snapshot","revision":revision,"conversationState":snapshot}}}),
                ),
            }
        }
    }
    fn snapshot(turn: &str, items: Value) -> Value {
        json!({"id":SESSION,"hostId":"local","threadRuntimeStatus":{"type":"active"},"turns":[{"turnId":turn,"status":"inProgress","items":items}],"requests":[]})
    }
    fn inspect(snapshot: Value, check: impl FnOnce(Value)) {
        let (_dir, path, listener) = endpoint();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            select(&mut socket, "owner", 1, snapshot);
            while let Some(request) = read(&mut socket) {
                assert_eq!(request["method"], "thread-stream-following-changed");
                assert_eq!(request["params"]["following"], false);
            }
        });
        let mut bridge = Bridge::connect(&path, Compatibility::default()).unwrap();
        bridge.select(SESSION).unwrap();
        let hub = crate::session_stream::Hub::new("boot".into(), |_| true);
        let observed = ObservedBridge::new(bridge, Some(hub.publisher("s", "codex-follower")));
        check(hub.subscribe("s", None).unwrap()["events"][0]["payload"].clone());
        drop(observed);
        server.join().unwrap();
    }

    #[test]
    fn long_canonical_history_and_tool_turn_keep_the_latest_live_item() {
        let items: Vec<_> = (0..120).map(|index| json!({"id":format!("tool-{index}"),"type":"commandExecution","status":"completed"})).chain(std::iter::once(json!({"id":"latest","type":"agentMessage","text":"current reply"}))).collect();
        let mut current = snapshot("active", json!(items));
        let history: Vec<_> = (0..25)
            .map(|index| json!({"turnId":format!("old-{index}"),"status":"completed","items":[]}))
            .collect();
        current["turnHistory"] = json!({"kind":"canonical","history":{
            "islands":[{"entries":(0..25).map(|index| json!({"value":index.to_string()})).collect::<Vec<_>>() }],
            "entitiesByKey":history.into_iter().enumerate().map(|(index, turn)| (index.to_string(), turn)).collect::<serde_json::Map<_,_>>()
        }});
        inspect(current, |projection| {
            assert_eq!(projection["live"]["streamText"], "current reply");
            let items = projection["items"].as_array().unwrap();
            assert_eq!(items.len(), 100);
            assert_eq!(items.last().unwrap()["id"], "latest");
            assert!(items.iter().all(|item| item["turn_id"] == "active"));
            assert_eq!(projection["authoritativeTurnIds"], json!([]));
        });
    }

    #[test]
    fn canonical_and_live_copies_are_deduplicated_with_live_content_last() {
        let live = json!({"turnId":"active","status":"inProgress","items":[{"text":"new"}]});
        let old = json!({"turnId":"old","status":"completed","items":[]});
        let canonical = json!({"turnId":"active","status":"inProgress","items":[{"text":"old"}]});
        let selected = recent_turns(
            vec![&live, &old, &canonical],
            1,
            Some("active"),
            &BTreeSet::new(),
        );
        assert_eq!(selected, vec![&old, &live]);
    }

    #[test]
    fn authoritative_user_rows_preserve_native_attachment_counts() {
        inspect(
            snapshot(
                "active",
                json!([
                    {"id":"user","type":"userMessage","content":[{"type":"text","text":"review"},{"type":"localImage","path":"/fixture/image.png"},{"type":"image","imageUrl":"data:image/png;base64,fixture"},{"type":"document"}]},
                    {"id":"answer","type":"agentMessage","text":"reply"}
                ]),
            ),
            |projection| {
                assert_eq!(projection["authoritativeTurnIds"], json!(["active"]));
                let user = projection["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|item| item["id"] == "user")
                    .unwrap();
                assert_eq!(user["attachment_count"], 3);
                assert_eq!(user["content"], "review");
                assert!(!projection.to_string().contains("/fixture/image.png"));
            },
        );
    }

    #[test]
    fn completion_and_reconnect_preserve_text_and_bound_complete_coverage() {
        for (content, expected_bytes, truncated) in [
            ("x".repeat(40_000), 40_000, false),
            ("界".repeat(40_000), 120_000, false),
            (
                "x".repeat(MAX_ITEM_TEXT_BYTES + 1),
                MAX_ITEM_TEXT_BYTES,
                true,
            ),
            (
                format!("{}界", "x".repeat(MAX_ITEM_TEXT_BYTES - 2)),
                MAX_ITEM_TEXT_BYTES - 2,
                true,
            ),
        ] {
            let (_dir, path, listener) = endpoint();
            let (release, trigger) = mpsc::channel();
            let native_content = content.clone();
            let server = std::thread::spawn(move || {
                let (mut first, _) = listener.accept().unwrap();
                let mut current = snapshot(
                    "turn",
                    json!([{"id":"answer","type":"agentMessage","text":native_content}]),
                );
                select(&mut first, "owner", 1, current.clone());
                trigger.recv().unwrap();
                current["threadRuntimeStatus"]["type"] = json!("idle");
                current["turns"][0]["status"] = json!("completed");
                write(
                    &mut first,
                    json!({"type":"broadcast","sourceClientId":"owner","version":11,"method":"thread-stream-state-changed","params":{"hostId":"local","conversationId":SESSION,"change":{"type":"snapshot","revision":2,"conversationState":current}}}),
                );
                trigger.recv().unwrap();
                write(
                    &mut first,
                    json!({"type":"broadcast","sourceClientId":"owner","version":1,"method":"client-status-changed","params":{"clientId":"owner","status":"disconnected"}}),
                );
                let (mut second, _) = listener.accept().unwrap();
                select(&mut second, "new-owner", 1, current);
                while let Some(request) = read(&mut second) {
                    assert_eq!(request["method"], "thread-stream-following-changed");
                    assert_eq!(request["params"]["following"], false);
                }
            });
            let mut bridge = Bridge::connect(&path, Compatibility::default()).unwrap();
            bridge.select(SESSION).unwrap();
            let (published, events) = mpsc::channel();
            let hub = crate::session_stream::Hub::new("boot".into(), move |event| {
                published.send(event).is_ok()
            });
            let observed = ObservedBridge::new(bridge, Some(hub.publisher("s", "codex-follower")));
            let baseline = hub.subscribe("s", None).unwrap();
            let expected = &content[..expected_bytes];
            let check_projection = |projection: &Value| {
                let items = projection["items"].as_array().unwrap();
                assert_eq!(items.len(), 1);
                assert_eq!(items[0]["id"], "answer");
                assert_eq!(items[0]["content"], expected);
                assert_eq!(items[0]["truncated"], truncated);
                assert_eq!(items[0]["ephemeral"], true);
                assert_eq!(projection["preserveItemsOutsideCoverage"], true);
                assert_eq!(
                    projection["authoritativeTurnIds"],
                    if truncated {
                        json!([])
                    } else {
                        json!(["turn"])
                    }
                );
            };
            check_projection(&baseline["events"][0]["payload"]);
            release.send(()).unwrap();
            loop {
                let event = events.recv_timeout(Duration::from_secs(3)).unwrap();
                if event["type"] == "state" && event["payload"]["status"] == "idle" {
                    break;
                }
            }
            let completed = hub.subscribe("s", None).unwrap();
            check_projection(&completed["events"][0]["payload"]);
            release.send(()).unwrap();
            let recovered = loop {
                let event = events.recv_timeout(Duration::from_secs(3)).unwrap();
                if event["type"] == "snapshot" && event["epoch"] != baseline["events"][0]["epoch"] {
                    break event;
                }
            };
            check_projection(&recovered["payload"]);
            assert_eq!(recovered["payload"]["live"]["status"], "idle");
            let resubscribed = hub.subscribe("s", completed["cursor"].as_str()).unwrap();
            check_projection(&resubscribed["events"][0]["payload"]);
            drop(observed);
            server.join().unwrap();
        }
    }

    #[test]
    fn invalidated_owner_reconnects_without_requests_and_replaces_epoch() {
        let (_dir, path, listener) = endpoint();
        let (release, trigger) = mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut first, _) = listener.accept().unwrap();
            select(
                &mut first,
                "old-owner",
                40,
                snapshot(
                    "old-turn",
                    json!([{"id":"old-item","type":"agentMessage","text":"old owner"}]),
                ),
            );
            trigger.recv().unwrap();
            write(
                &mut first,
                json!({"type":"broadcast","sourceClientId":"old-owner","version":1,"method":"client-status-changed","params":{"clientId":"old-owner","status":"disconnected"}}),
            );
            let (mut second, _) = listener.accept().unwrap();
            select(
                &mut second,
                "new-owner",
                1,
                snapshot(
                    "new-turn",
                    json!([{"id":"new-item","type":"agentMessage","text":"new owner"}]),
                ),
            );
            while let Some(request) = read(&mut second) {
                assert_eq!(request["method"], "thread-stream-following-changed");
                assert_eq!(request["params"]["following"], false);
            }
        });
        let mut bridge = Bridge::connect(&path, Compatibility::default()).unwrap();
        bridge.select(SESSION).unwrap();
        let (tx, rx) = mpsc::channel();
        let hub =
            crate::session_stream::Hub::new("boot".into(), move |event| tx.send(event).is_ok());
        let observed = ObservedBridge::new(bridge, Some(hub.publisher("s", "codex-follower")));
        let baseline = hub.subscribe("s", None).unwrap();
        release.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let recovered = loop {
            let event = rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap();
            if event["type"] == "snapshot" && event["epoch"] != baseline["events"][0]["epoch"] {
                break event;
            }
        };
        assert_eq!(recovered["payload"]["live"]["revision"], 1);
        assert_eq!(recovered["payload"]["items"].as_array().unwrap().len(), 1);
        assert_eq!(recovered["payload"]["items"][0]["id"], "new-item");
        assert_eq!(recovered["payload"]["removedTurnIds"], json!(["old-turn"]));
        assert_eq!(
            hub.subscribe("s", baseline["cursor"].as_str()).unwrap()["events"][0]["epoch"],
            recovered["epoch"]
        );
        drop(observed);
        server.join().unwrap();
    }
}
